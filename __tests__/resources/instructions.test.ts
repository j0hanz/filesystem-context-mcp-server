import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildServerInstructions } from '../../src/resources/instructions.js';

describe('buildServerInstructions', () => {
  it('contains all four required sections', () => {
    const content = buildServerInstructions();
    assert.match(content, /<role>/u);
    assert.match(content, /<tools_overview>/u);
    assert.match(content, /<constraints>/u);
    assert.match(content, /<error_recovery>/u);
  });

  it('includes known tool names in the overview table', () => {
    const content = buildServerInstructions();
    assert.match(content, /`roots`/u);
    assert.match(content, /`ls`/u);
    assert.match(content, /`grep`/u);
    assert.match(content, /`read`/u);
    assert.match(content, /`write`/u);
  });

  it('points to tools/list for schemas', () => {
    const content = buildServerInstructions();
    assert.match(content, /tools\/list/u);
  });

  it('includes all five error recovery codes', () => {
    const content = buildServerInstructions();
    assert.match(content, /ACCESS_DENIED/u);
    assert.match(content, /NOT_FOUND/u);
    assert.match(content, /TOO_LARGE/u);
    assert.match(content, /TIMEOUT/u);
    assert.match(content, /INVALID_INPUT/u);
  });

  it('mentions resourceUri cache behaviour', () => {
    const content = buildServerInstructions();
    assert.match(content, /resourceUri/u);
    assert.match(content, /resources\/read/u);
  });

  it('describes cache expiry with TTL and eviction, not just restart', () => {
    const content = buildServerInstructions();
    assert.match(content, /ephemeral/u);
    assert.match(content, /30 min/u);
    assert.match(content, /eviction/u);
    assert.doesNotMatch(content, /expire on server restart/u);
  });

  it('returns a non-empty string on every call (idempotent)', () => {
    assert.ok(buildServerInstructions().length > 200);
    assert.strictEqual(buildServerInstructions(), buildServerInstructions());
  });
});
