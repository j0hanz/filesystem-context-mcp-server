import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectMimeType, type MimeKind } from '../src/core/fs.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePngBuffer(): Buffer {
  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function makeJpegBuffer(): Buffer {
  // JPEG magic bytes: FF D8 FF
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
}

function makePdfBuffer(): Buffer {
  // PDF magic bytes: 25 50 44 46 (%)PDF
  return Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
}

function makeZipBuffer(): Buffer {
  // ZIP magic bytes: 50 4B 03 04
  return Buffer.from([0x50, 0x4b, 0x03, 0x04]);
}

function makeTextBuffer(): Buffer {
  return Buffer.from('hello world');
}

// ─── detectMimeType ─────────────────────────────────────────────────────────

describe('detectMimeType', () => {
  it('detects TypeScript by extension', () => {
    const result = detectMimeType('script.ts');
    assert.equal(result.mimeType, 'text/typescript');
    assert.equal(result.kind, 'text');
  });

  it('detects PNG by extension', () => {
    const result = detectMimeType('image.png');
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.kind, 'image');
  });

  it('detects PDF by extension', () => {
    const result = detectMimeType('document.pdf');
    assert.equal(result.mimeType, 'application/pdf');
    assert.equal(result.kind, 'pdf');
  });

  it('detects PNG by magic bytes (no extension)', () => {
    const sample = makePngBuffer();
    const result = detectMimeType('unknown', sample);
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.kind, 'image');
  });

  it('detects JSON by extension', () => {
    const result = detectMimeType('config.json');
    assert.equal(result.mimeType, 'application/json');
    assert.equal(result.kind, 'text');
  });

  it('detects Markdown by extension', () => {
    const result = detectMimeType('README.md');
    assert.equal(result.mimeType, 'text/markdown');
    assert.equal(result.kind, 'text');
  });

  it('detects diff by extension', () => {
    const result = detectMimeType('changes.diff');
    assert.equal(result.mimeType, 'text/x-diff');
    assert.equal(result.kind, 'text');
  });

  it('falls back to text/plain for unknown text files', () => {
    const sample = makeTextBuffer();
    const result = detectMimeType('unknown.xyz', sample);
    assert.equal(result.mimeType, 'text/plain');
    assert.equal(result.kind, 'text');
  });

  it('falls back to application/octet-stream for unknown binary files', () => {
    const sample = makeZipBuffer();
    const result = detectMimeType('unknown', sample);
    assert.equal(result.mimeType, 'application/zip');
    assert.equal(result.kind, 'binary');
  });

  it('detects JPEG by magic bytes', () => {
    const sample = makeJpegBuffer();
    const result = detectMimeType('photo', sample);
    assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(result.kind, 'image');
  });

  it('detects PDF by magic bytes', () => {
    const sample = makePdfBuffer();
    const result = detectMimeType('mystery.bin', sample);
    assert.equal(result.mimeType, 'application/pdf');
    assert.equal(result.kind, 'pdf');
  });

  it('prioritizes extension over magic bytes when both available', () => {
    // PNG magic bytes but .json extension should prefer extension
    const sample = makePngBuffer();
    const result = detectMimeType('file.json', sample);
    assert.equal(result.mimeType, 'application/json');
    assert.equal(result.kind, 'text');
  });

  it('returns correct kind for image formats', () => {
    const kinds: Record<string, MimeKind> = {
      'image.png': 'image',
      'photo.jpg': 'image',
      'photo.jpeg': 'image',
      'photo.gif': 'image',
      'photo.webp': 'image',
      'photo.svg': 'image',
    };

    for (const [path, expectedKind] of Object.entries(kinds)) {
      const result = detectMimeType(path);
      assert.equal(result.kind, expectedKind, `${path} should have kind '${expectedKind}'`);
    }
  });
});


