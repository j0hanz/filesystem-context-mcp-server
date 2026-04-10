import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { patchToolListWithIcons } from '../../server/tool-icons-patch.js';
import type { ToolContract } from '../../tools/contract.js';
import type { IconInfo } from '../../tools/shared.js';

function makeTool(name: string, icons?: ToolContract['icons']): ToolContract {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', additionalProperties: false },
    ...(icons ? { icons } : {}),
  } as unknown as ToolContract;
}

function createMockServer(toolNames: string[]): {
  server: Parameters<typeof patchToolListWithIcons>[0];
  handlers: Map<string, unknown>;
} {
  const handlers = new Map<string, unknown>();

  // Seed a tools/list handler that returns tools without icons
  handlers.set('tools/list', async () => ({
    tools: toolNames.map((name) => ({ name, description: `${name} tool` })),
  }));

  const server = {
    server: { _requestHandlers: handlers },
  };

  return { server: server as never, handlers };
}

const FALLBACK: IconInfo = {
  src: 'data:image/svg+xml;base64,FALLBACK',
  mimeType: 'image/svg+xml',
};

const CUSTOM_ICONS = [
  { src: 'data:image/svg+xml;base64,CUSTOM', mimeType: 'image/svg+xml' },
];

describe('patchToolListWithIcons', () => {
  it('returns false when _requestHandlers is missing', () => {
    const server = { server: {} } as never;
    assert.equal(patchToolListWithIcons(server, [], undefined), false);
  });

  it('returns false when no tools/list handler exists', () => {
    const server = { server: { _requestHandlers: new Map() } } as never;
    assert.equal(patchToolListWithIcons(server, [], undefined), false);
  });

  it('returns false when icon map is empty (no icons, no fallback)', () => {
    const { server } = createMockServer(['read']);
    const tools = [makeTool('read')];
    assert.equal(patchToolListWithIcons(server, tools, undefined), false);
  });

  it('injects fallback icons for tools without specific icons', async () => {
    const { server, handlers } = createMockServer(['read', 'write']);
    const tools = [makeTool('read'), makeTool('write')];

    const patched = patchToolListWithIcons(server, tools, FALLBACK);
    assert.equal(patched, true);

    const handler = handlers.get('tools/list') as (
      req: unknown,
      extra: unknown
    ) => Promise<{ tools: Array<{ name: string; icons?: unknown[] }> }>;
    const result = await handler({}, {});

    assert.equal(result.tools[0]!.icons!.length, 1);
    assert.equal(result.tools[1]!.icons!.length, 1);
    assert.deepEqual(result.tools[0]!.icons![0], {
      src: FALLBACK.src,
      mimeType: FALLBACK.mimeType,
    });
  });

  it('injects specific tool icons over fallback', async () => {
    const { server, handlers } = createMockServer(['read', 'write']);
    const tools = [makeTool('read', CUSTOM_ICONS), makeTool('write')];

    patchToolListWithIcons(server, tools, FALLBACK);

    const handler = handlers.get('tools/list') as (
      req: unknown,
      extra: unknown
    ) => Promise<{ tools: Array<{ name: string; icons?: unknown[] }> }>;
    const result = await handler({}, {});

    assert.deepEqual(result.tools[0]!.icons, CUSTOM_ICONS);
    assert.deepEqual(result.tools[1]!.icons, [
      { src: FALLBACK.src, mimeType: FALLBACK.mimeType },
    ]);
  });

  it('does not overwrite icons already present in SDK response', async () => {
    const existingIcons = [
      { src: 'data:image/svg+xml;base64,SDK', mimeType: 'image/svg+xml' },
    ];
    const handlers = new Map<string, unknown>();
    handlers.set('tools/list', async () => ({
      tools: [{ name: 'read', icons: existingIcons }],
    }));
    const server = { server: { _requestHandlers: handlers } } as never;

    const tools = [makeTool('read', CUSTOM_ICONS)];
    patchToolListWithIcons(server, tools, FALLBACK);

    const handler = handlers.get('tools/list') as (
      req: unknown,
      extra: unknown
    ) => Promise<{ tools: Array<{ name: string; icons?: unknown[] }> }>;
    const result = await handler({}, {});

    assert.deepEqual(result.tools[0]!.icons, existingIcons);
  });
});
