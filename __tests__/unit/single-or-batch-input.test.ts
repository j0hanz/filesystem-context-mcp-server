import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as z from 'zod/v4';

import { singleOrBatchPathsInput } from '../../src/core/schema.js';

describe('singleOrBatchPathsInput', () => {
  const binary = singleOrBatchPathsInput({ extra: { flag: z.boolean().optional() } });
  const triadic = singleOrBatchPathsInput({
    extra: { dryRun: z.boolean().optional() },
    perFile: { edits: z.array(z.string()).min(1) },
    maxBatch: 5,
  });

  it('accepts { path }', () => {
    const r = binary.safeParse({ path: '/tmp/a' });
    assert.equal(r.success, true);
  });

  it('accepts { paths: [...] }', () => {
    const r = binary.safeParse({ paths: ['/tmp/a', '/tmp/b'] });
    assert.equal(r.success, true);
  });

  it("rejects when neither 'path' nor 'paths' provided", () => {
    const r = binary.safeParse({});
    assert.equal(r.success, false);
    assert.equal(r.error.issues[0]?.message, "Either 'path' or 'paths' must be provided");
  });

  it('rejects when both path and paths provided', () => {
    const r = binary.safeParse({ path: '/tmp/a', paths: ['/tmp/b'] });
    assert.equal(r.success, false);
    assert.equal(r.error.issues[0]?.message, "Cannot use both 'path' and 'paths'");
  });

  it("rejects 'files' on a binary schema (no perFile configured)", () => {
    const r = binary.safeParse({ files: [{ path: '/tmp/a' }] });
    assert.equal(r.success, false);
  });

  it('accepts { files: [...] } when perFile is configured', () => {
    const r = triadic.safeParse({ files: [{ path: '/tmp/a', edits: ['x'] }] });
    assert.equal(r.success, true);
  });

  it('rejects more than one of path/paths/files when triadic', () => {
    const r = triadic.safeParse({ path: '/tmp/a', paths: ['/tmp/b'] });
    assert.equal(r.success, false);
    assert.equal(r.error.issues[0]?.message, "Provide exactly one of 'path', 'paths', or 'files'");
  });

  it('enforces maxBatch on paths', () => {
    const r = triadic.safeParse({ paths: ['/a', '/b', '/c', '/d', '/e', '/f'] });
    assert.equal(r.success, false);
  });

  it('composes with tool-specific .superRefine (issue from refinement is reported)', () => {
    const composed = binary.superRefine((v, ctx) => {
      if (v.path === '/forbidden') {
        ctx.addIssue({ code: 'custom', path: ['path'], message: 'forbidden', input: v });
      }
    });
    const r = composed.safeParse({ path: '/forbidden' });
    assert.equal(r.success, false);
    assert.equal(r.error.issues[0]?.message, 'forbidden');
  });
});
