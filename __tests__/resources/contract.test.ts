import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ALL_RESOURCES } from '../../src/resources.js';

describe('resource contracts', () => {
  it('registers exactly 7 resources', () => {
    assert.strictEqual(ALL_RESOURCES.length, 7);
  });

  it('all resources have unique names', () => {
    const names = ALL_RESOURCES.map((r) => r.name);
    assert.strictEqual(new Set(names).size, names.length);
  });

  it('all resources have required fields', () => {
    for (const r of ALL_RESOURCES) {
      assert.ok(r.name.length > 0, `${r.name}: name must be non-empty`);
      assert.ok(r.title.length > 0, `${r.name}: title must be non-empty`);
      assert.ok(
        r.description.length > 0,
        `${r.name}: description must be non-empty`
      );
      assert.ok(r.mimeType.length > 0, `${r.name}: mimeType must be non-empty`);
      assert.ok(
        r.uri !== undefined || r.uriTemplate !== undefined,
        `${r.name}: must have either uri or uriTemplate`
      );
      assert.ok(
        r.annotations.audience.length > 0,
        `${r.name}: audience must be non-empty`
      );
      assert.ok(
        r.annotations.priority >= 0 && r.annotations.priority <= 1,
        `${r.name}: priority must be between 0 and 1`
      );
    }
  });

  it('only metrics and filesystem-file have createSubscription', () => {
    const withSub = ALL_RESOURCES.filter(
      (r) => r.createSubscription !== undefined
    );
    const names = withSub.map((r) => r.name).sort();
    assert.deepStrictEqual(names, [
      'filesystem-mcp-file',
      'filesystem-mcp-metrics',
    ]);
  });

  it('static resources have uri, template resources have uriTemplate', () => {
    const staticNames = [
      'filesystem-mcp-instructions',
      'filesystem-mcp-catalog',
      'filesystem-mcp-workflows',
      'filesystem-mcp-metrics',
    ];
    const templateNames = [
      'filesystem-mcp-tool-info',
      'filesystem-mcp-result',
      'filesystem-mcp-file',
    ];

    for (const r of ALL_RESOURCES) {
      if (staticNames.includes(r.name)) {
        assert.ok(
          r.uri !== undefined,
          `${r.name}: static resource must have uri`
        );
      } else if (templateNames.includes(r.name)) {
        assert.ok(
          r.uriTemplate !== undefined,
          `${r.name}: template resource must have uriTemplate`
        );
      }
    }
  });
});
