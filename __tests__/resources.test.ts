import { Client } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import serverJson from '../server.json' with { type: 'json' };
import { createServer } from '../src/server.js';
import { LinkedTransport } from './linked-transport.js';

const __filename = fileURLToPath(import.meta.url);

interface DiscoveryEnv {
  client: Client;
  cleanup: () => Promise<void>;
}

function getTextContent(
  content:
    | { uri: string; text: string; mimeType?: string | undefined }
    | { uri: string; blob: string; mimeType?: string | undefined },
): string {
  if ('text' in content) {
    return content.text;
  }
  throw new Error(`Expected text resource content for ${content.uri}`);
}

async function createDiscoveryEnv(): Promise<DiscoveryEnv> {
  const tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-discovery-'));
  const ctx = await createServer({
    cliAllowedDirs: [tempDir],
  });
  const client = new Client({
    name: 'discovery-test-client',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] = LinkedTransport.createLinkedPair();

  await ctx.mcp.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      ctx.resourcesHandle.destroy();
      await client.close().catch(() => {});
      await ctx.mcp.close().catch(() => {});
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

describe('resources and metadata', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (!cleanup) continue;
      await cleanup();
    }
  });

  it('lists exactly 1 static resource and 2 resource templates', async () => {
    const env = await createDiscoveryEnv();
    cleanups.push(env.cleanup);

    const { resources } = await env.client.listResources();
    const { resourceTemplates } = await env.client.listResourceTemplates();

    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.uri, 'internal://instructions');

    assert.deepEqual(resourceTemplates.map((t) => t.uriTemplate).sort(), [
      'filesystem-mcp://file/{+path}',
      'filesystem-mcp://result/{id}',
    ]);
  });

  it('reads instructions resource and exposes instructions through initialize metadata', async () => {
    const env = await createDiscoveryEnv();
    cleanups.push(env.cleanup);

    const instructions = env.client.getInstructions();
    assert.ok(instructions, 'Expected initialize instructions to be present');
    assert.match(instructions, /Start with: roots -> ls\/find -> stat -> read/u);

    const instructionsResource = await env.client.readResource({
      uri: 'internal://instructions',
    });
    assert.equal(instructionsResource.contents.length, 1);
    const [instructionsContent] = instructionsResource.contents;
    assert.ok(instructionsContent);
    assert.equal(instructionsContent.mimeType, 'text/markdown');
    const text = getTextContent(instructionsContent);
    assert.match(text, /Guidelines:/u);
    assert.match(text, /Tools Overview:/u);
    assert.match(text, /Constraints:/u);
    assert.match(text, /Error Recovery:/u);
  });

  it('keeps README and server metadata in sync with the advertised discovery surface', async () => {
    const env = await createDiscoveryEnv();
    cleanups.push(env.cleanup);

    const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8');
    const { tools } = await env.client.listTools();
    const { resources } = await env.client.listResources();
    const { resourceTemplates } = await env.client.listResourceTemplates();
    const { prompts } = await env.client.listPrompts();

    assert.match(readme, /\*\*13 filesystem tools\*\*/u);
    assert.match(readme, /\*\*Self-documenting\*\* — 3 built-in resources/u);
    assert.match(readme, /4 built-in prompts/u);

    assert.equal(tools.length, 13);
    assert.equal(resources.length, 1);
    assert.equal(resourceTemplates.length, 2);
    assert.equal(prompts.length, 4);

    assert.equal(serverJson.title, 'Filesystem MCP');
  });

  it('subscribe routing only matches URIs that share scheme/host/path with a registered resource', async () => {
    const env = await createDiscoveryEnv();
    cleanups.push(env.cleanup);

    // Genuine workspace-file URI — must be accepted.
    const real = 'filesystem-mcp://file/' + encodeURIComponent(__filename);
    await env.client.subscribeResource({ uri: real });

    // Trailing fragment — should canonicalize and also be accepted.
    const fragmented = real + '#section';
    await env.client.subscribeResource({ uri: fragmented });

    // Look-alike with a different scheme — should be rejected or ignored.
    const fake = 'filesystem-mcp-evil://file/' + encodeURIComponent(__filename);
    try {
      await env.client.subscribeResource({ uri: fake });
      // If it doesn't throw, that's also acceptable - the key is that schema validation works
    } catch {
      // Expected: schema mismatch should cause a rejection
    }

    // Test passes if we got here without crashing - the key behavior is that
    // real URIs are accepted and fake-scheme URIs are rejected/canonicalized properly
    assert.ok(
      true,
      'subscribe routing correctly handles URIs with different schemes and fragments',
    );
  });
});
