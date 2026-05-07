import { Client } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import serverJson from '../server.json' with { type: 'json' };
import { getToolContracts } from '../src/resources/tool-info.js';
import { createServer } from '../src/server.js';
import { LinkedTransport } from './linked-transport.js';

interface DiscoveryEnv {
  client: Client;
  cleanup: () => Promise<void>;
}

function getTextContent(
  content:
    | { uri: string; text: string; mimeType?: string | undefined }
    | { uri: string; blob: string; mimeType?: string | undefined }
): string {
  if ('text' in content) {
    return content.text;
  }
  throw new Error(`Expected text resource content for ${content.uri}`);
}

async function createDiscoveryEnv(): Promise<DiscoveryEnv> {
  const tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-discovery-'));
  const { server, resourcesHandle } = await createServer({
    cliAllowedDirs: [tempDir],
  });
  const client = new Client({
    name: 'discovery-test-client',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] = LinkedTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      resourcesHandle.destroy();
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

describe('resources and metadata', () => {
  const cleanups: (() => Promise<void>)[] = [];
  const staticResourceUris = [
    'filesystem-mcp://metrics',
    'internal://instructions',
    'internal://tool-catalog',
    'internal://workflows',
  ];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (!cleanup) continue;
      await cleanup();
    }
  });

  it('lists fixed resources and dynamic resource templates', async () => {
    const env = await createDiscoveryEnv();
    cleanups.push(env.cleanup);

    const { resources } = await env.client.listResources();
    const { resourceTemplates } = await env.client.listResourceTemplates();
    const resourceUris = resources.map((resource) => resource.uri).sort();
    const toolInfoUris = getToolContracts()
      .map((contract) => `internal://tool-info/${contract.name}`)
      .sort();

    assert.equal(
      resources.length,
      staticResourceUris.length + toolInfoUris.length
    );
    assert.deepEqual(
      resourceUris,
      [...staticResourceUris, ...toolInfoUris].sort()
    );

    assert.deepEqual(
      resourceTemplates.map((template) => template.uriTemplate).sort(),
      [
        'filesystem-mcp://file/{+path}',
        'filesystem-mcp://result/{id}',
        'internal://tool-info/{name}',
      ]
    );
  });

  it('reads built-in resources and exposes instructions through initialize metadata', async () => {
    const env = await createDiscoveryEnv();
    cleanups.push(env.cleanup);

    const instructions = env.client.getInstructions();
    assert.ok(instructions, 'Expected initialize instructions to be present');
    assert.match(
      instructions,
      /Start with: roots -> ls\/find -> stat -> read/u
    );

    const instructionsResource = await env.client.readResource({
      uri: 'internal://instructions',
    });
    assert.equal(instructionsResource.contents.length, 1);
    const [instructionsContent] = instructionsResource.contents;
    assert.ok(instructionsContent);
    assert.equal(instructionsContent.mimeType, 'text/markdown');
    assert.match(getTextContent(instructionsContent), /## /u);

    const metricsResource = await env.client.readResource({
      uri: 'filesystem-mcp://metrics',
    });
    const [metricsContent] = metricsResource.contents;
    assert.ok(metricsContent);
    const metricsPayload = JSON.parse(getTextContent(metricsContent)) as {
      ok?: boolean;
      metrics?: Record<string, unknown>;
    };
    assert.equal(metricsPayload.ok, true);
    assert.ok(metricsPayload.metrics, 'Expected metrics object');
  });

  it('reads tool-info template instances and get-tool-help embeds the same resource URI', async () => {
    const env = await createDiscoveryEnv();
    cleanups.push(env.cleanup);

    const toolInfo = await env.client.readResource({
      uri: 'internal://tool-info/read',
    });
    const [toolInfoContent] = toolInfo.contents;
    assert.ok(toolInfoContent);
    assert.match(getTextContent(toolInfoContent), /# read/u);

    const prompt = await env.client.getPrompt({
      name: 'get-tool-help',
      arguments: { name: 'read' },
    });
    const resourceMessage = prompt.messages[1];
    assert.ok(resourceMessage);
    assert.equal(resourceMessage.content.type, 'resource');
    assert.equal(
      resourceMessage.content.resource.uri,
      'internal://tool-info/read'
    );
  });

  it('keeps README and server metadata in sync with the advertised discovery surface', async () => {
    const env = await createDiscoveryEnv();
    cleanups.push(env.cleanup);

    const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8');
    const { tools } = await env.client.listTools();
    const { resources } = await env.client.listResources();
    const { resourceTemplates } = await env.client.listResourceTemplates();
    const { prompts } = await env.client.listPrompts();
    const toolInfoUris = getToolContracts()
      .map((contract) => `internal://tool-info/${contract.name}`)
      .sort();
    const resourceUris = resources.map((resource) => resource.uri).sort();

    assert.match(readme, /\*\*18 filesystem tools\*\*/u);
    assert.match(readme, /\*\*Self-documenting\*\* — 7 built-in resources/u);
    assert.match(readme, /4 built-in prompts/u);

    assert.equal(tools.length, 18);
    assert.deepEqual(
      resourceUris,
      [...staticResourceUris, ...toolInfoUris].sort()
    );
    assert.equal(staticResourceUris.length + resourceTemplates.length, 7);
    assert.equal(prompts.length, 4);

    assert.equal(serverJson.title, 'Filesystem MCP');
    assert.equal(
      serverJson.description,
      'Secure filesystem MCP server for reading, writing, searching, diffing, and patching files.'
    );
  });
});
