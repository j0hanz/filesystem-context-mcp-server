import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSlimInstructions } from '../../src/resources/instructions-content.js';

describe('buildSlimInstructions', () => {
  it('contains all four required sections', () => {
    const content = buildSlimInstructions();
    assert.match(content, /## Role/u);
    assert.match(content, /## Tools Overview/u);
    assert.match(content, /## Constraints/u);
    assert.match(content, /## Error Recovery/u);
  });

  it('includes known tool names in the overview table', () => {
    const content = buildSlimInstructions();
    assert.match(content, /`roots`/u);
    assert.match(content, /`ls`/u);
    assert.match(content, /`grep`/u);
    assert.match(content, /`read`/u);
    assert.match(content, /`write`/u);
  });

  it('points to tools/list for schemas', () => {
    const content = buildSlimInstructions();
    assert.match(content, /tools\/list/u);
  });

  it('includes all five error recovery codes', () => {
    const content = buildSlimInstructions();
    assert.match(content, /ACCESS_DENIED/u);
    assert.match(content, /NOT_FOUND/u);
    assert.match(content, /TOO_LARGE/u);
    assert.match(content, /TIMEOUT/u);
    assert.match(content, /INVALID_INPUT/u);
  });

  it('mentions resourceUri cache behaviour', () => {
    const content = buildSlimInstructions();
    assert.match(content, /resourceUri/u);
    assert.match(content, /resources\/read/u);
  });

  it('describes cache expiry with TTL and eviction, not just restart', () => {
    const content = buildSlimInstructions();
    assert.match(content, /ephemeral/u);
    assert.match(content, /30 min/u);
    assert.match(content, /eviction/u);
    assert.doesNotMatch(content, /expire on server restart/u);
  });

  it('returns a non-empty string on every call (idempotent)', () => {
    assert.ok(buildSlimInstructions().length > 200);
    assert.strictEqual(buildSlimInstructions(), buildSlimInstructions());
  });
});
