import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildSectionsRecord } from '../../src/resources.js';
import { createTestEnv, getStructured, type PerPathResult } from '../helpers.js';

const INSTRUCTION_SECTIONS = buildSectionsRecord(false);
const SERVER_INSTRUCTIONS_CONTENT = `\n${Object.values(INSTRUCTION_SECTIONS).join('\n\n')}\n`;

describe('SERVER_INSTRUCTIONS_CONTENT', () => {
  it('contains all four required sections', () => {
    const content = SERVER_INSTRUCTIONS_CONTENT;
    assert.match(content, /Guidelines:/u);
    assert.match(content, /Tools Overview:/u);
    assert.match(content, /Constraints:/u);
    assert.match(content, /Error Recovery:/u);
  });

  it('includes known tool names in the overview', () => {
    const content = SERVER_INSTRUCTIONS_CONTENT;
    assert.match(content, /list_roots/u);
    assert.match(content, /ls/u);
    assert.match(content, /search_text/u);
    assert.match(content, /read/u);
    assert.match(content, /create/u);
  });

  it('points to tools/list for schemas', () => {
    const content = SERVER_INSTRUCTIONS_CONTENT;
    assert.match(content, /tools\/list/u);
  });

  it('includes all five error recovery codes', () => {
    const content = SERVER_INSTRUCTIONS_CONTENT;
    assert.match(content, /ACCESS_DENIED/u);
    assert.match(content, /NOT_FOUND/u);
    assert.match(content, /TOO_LARGE/u);
    assert.match(content, /TIMEOUT/u);
    assert.match(content, /INVALID_INPUT/u);
  });

  it('mentions resourceUri cache behaviour', () => {
    const content = SERVER_INSTRUCTIONS_CONTENT;
    assert.match(content, /resourceUri/u);
    assert.match(content, /resources\/read/u);
  });

  it('describes cache expiry with TTL and eviction, not just restart', () => {
    const content = SERVER_INSTRUCTIONS_CONTENT;
    assert.match(content, /ephemeral/u);
    assert.match(content, /60 seconds/u);
    assert.match(content, /eviction/u);
    assert.doesNotMatch(content, /expire on server restart/u);
  });

  it('is a non-empty string', () => {
    assert.ok(SERVER_INSTRUCTIONS_CONTENT.length > 200);
  });
});

describe('INSTRUCTION_SECTIONS', () => {
  it('exposes the four documented sections as non-empty strings', () => {
    const keys = Object.keys(INSTRUCTION_SECTIONS).sort();
    assert.deepEqual(keys, ['constraints', 'error_recovery', 'guidelines', 'tools_overview']);
    for (const [name, body] of Object.entries(INSTRUCTION_SECTIONS)) {
      assert.equal(typeof body, 'string', `${name} must be string`);
      assert.ok(body.trim().length > 0, `${name} must not be empty`);
    }
  });

  it('SERVER_INSTRUCTIONS_CONTENT contains every section body', () => {
    for (const body of Object.values(INSTRUCTION_SECTIONS)) {
      assert.ok(
        SERVER_INSTRUCTIONS_CONTENT.includes(body.trim()),
        'rendered instructions must include every section body',
      );
    }
  });
});

describe('guidance text names only registered tools', () => {
  it('no prompt or error suggestion mentions a tool that does not exist', async () => {
    const env = await createTestEnv();
    try {
      const listed = await env.client.listTools();
      const registered = new Set(listed.tools.map((t: { name: string }) => t.name));
      // Names that were left behind by an earlier rename.
      const retired = ['tree', 'ls', 'find', 'grep', 'read_many', 'roots'];
      for (const name of retired) {
        assert.equal(registered.has(name), false, `${name} is not a registered tool`);
      }

      // The NOT_FOUND suggestion ships on the most common failure path.
      const missing = await env.client.callTool({
        name: 'stat',
        arguments: { path: join(env.tmpDir, 'nope.txt') },
      });
      const results = getStructured(missing)['results'] as PerPathResult[];
      const combined = JSON.stringify(results[0]?.error ?? {});
      for (const name of retired) {
        assert.doesNotMatch(
          combined,
          new RegExp(`\\b${name}\\b`, 'u'),
          `error guidance must not name the retired tool ${name}`,
        );
      }
    } finally {
      await env.cleanup();
    }
  });
});
