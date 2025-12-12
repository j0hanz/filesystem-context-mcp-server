import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readMediaFile } from '../../lib/file-operations.js';
import { normalizePath } from '../../lib/path-utils.js';
import { setAllowedDirectories } from '../../lib/path-validation.js';

describe('image parsing', () => {
  let testDir: string;

  // Test image generators - create minimal valid images
  const createMinimalPng = (): Buffer => {
    // Minimal 1x1 transparent PNG
    return Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR length
      0x49,
      0x48,
      0x44,
      0x52, // 'IHDR'
      0x00,
      0x00,
      0x00,
      0x01, // width: 1
      0x00,
      0x00,
      0x00,
      0x01, // height: 1
      0x08,
      0x06, // bit depth: 8, color type: RGBA
      0x00,
      0x00,
      0x00, // compression, filter, interlace
      0x1f,
      0x15,
      0xc4,
      0x89, // CRC
      0x00,
      0x00,
      0x00,
      0x0a, // IDAT length
      0x49,
      0x44,
      0x41,
      0x54, // 'IDAT'
      0x78,
      0x9c,
      0x63,
      0x00,
      0x01,
      0x00,
      0x00,
      0x05,
      0x00,
      0x01, // compressed data
      0x0d,
      0x0a,
      0x2d,
      0xb4, // CRC
      0x00,
      0x00,
      0x00,
      0x00, // IEND length
      0x49,
      0x45,
      0x4e,
      0x44, // 'IEND'
      0xae,
      0x42,
      0x60,
      0x82, // CRC
    ]);
  };

  const createMinimalJpeg = (width: number, height: number): Buffer => {
    // Minimal JPEG with SOF0 frame containing dimensions
    const wHi = (width >> 8) & 0xff;
    const wLo = width & 0xff;
    const hHi = (height >> 8) & 0xff;
    const hLo = height & 0xff;
    return Buffer.from([
      0xff,
      0xd8, // SOI
      0xff,
      0xe0, // APP0
      0x00,
      0x10, // length
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00, // 'JFIF\0'
      0x01,
      0x01, // version
      0x00, // aspect ratio units
      0x00,
      0x01, // X density
      0x00,
      0x01, // Y density
      0x00,
      0x00, // thumbnail dimensions
      0xff,
      0xc0, // SOF0 (baseline)
      0x00,
      0x0b, // length
      0x08, // precision
      hHi,
      hLo, // height
      wHi,
      wLo, // width
      0x01, // components
      0x01,
      0x11,
      0x00, // component data
      0xff,
      0xd9, // EOI
    ]);
  };

  const createMinimalGif = (width: number, height: number): Buffer => {
    // Minimal GIF89a
    const wLo = width & 0xff;
    const wHi = (width >> 8) & 0xff;
    const hLo = height & 0xff;
    const hHi = (height >> 8) & 0xff;
    return Buffer.from([
      0x47,
      0x49,
      0x46,
      0x38,
      0x39,
      0x61, // GIF89a
      wLo,
      wHi, // width
      hLo,
      hHi, // height
      0x00, // packed byte
      0x00, // background color
      0x00, // pixel aspect ratio
      0x3b, // trailer
    ]);
  };

  const createMinimalBmp = (width: number, height: number): Buffer => {
    // Minimal BMP header
    const wBytes = Buffer.alloc(4);
    const hBytes = Buffer.alloc(4);
    wBytes.writeInt32LE(width, 0);
    hBytes.writeInt32LE(height, 0);
    return Buffer.concat([
      Buffer.from([0x42, 0x4d]), // 'BM'
      Buffer.alloc(4), // file size (placeholder)
      Buffer.alloc(4), // reserved
      Buffer.from([0x36, 0x00, 0x00, 0x00]), // pixel offset
      Buffer.from([0x28, 0x00, 0x00, 0x00]), // DIB header size
      wBytes, // width
      hBytes, // height
      Buffer.from([0x01, 0x00]), // planes
      Buffer.from([0x18, 0x00]), // bits per pixel
      Buffer.alloc(24), // rest of header
    ]);
  };

  const createMinimalWebp = (width: number, height: number): Buffer => {
    // Minimal VP8L WebP (lossless)
    // This creates a valid WebP header with VP8L chunk
    // Layout: RIFF[4] + size[4] + WEBP[4] + VP8L[4] + chunkSize[4] + signature[1] + packed[4]
    const wMinus1 = width - 1;
    const hMinus1 = height - 1;
    // VP8L packed bits at offset 21: 14-bit width, 14-bit height
    const packed = (wMinus1 & 0x3fff) | ((hMinus1 & 0x3fff) << 14);
    const signature = 0x2f; // VP8L signature byte

    // VP8L chunk data: signature byte + 4-byte packed dimensions
    const vp8lData = Buffer.alloc(5);
    vp8lData[0] = signature;
    vp8lData.writeUInt32LE(packed, 1);

    // Build the complete WebP file
    const buffer = Buffer.alloc(30);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(22, 4); // File size - 8
    buffer.write('WEBP', 8);
    buffer.write('VP8L', 12);
    buffer.writeUInt32LE(5, 16); // VP8L chunk size
    vp8lData.copy(buffer, 20);

    return buffer;
  };

  beforeAll(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-img-test-'));
    setAllowedDirectories([normalizePath(testDir)]);

    // Create test images
    await fs.writeFile(path.join(testDir, 'test.png'), createMinimalPng());
    await fs.writeFile(
      path.join(testDir, 'test.jpg'),
      createMinimalJpeg(320, 240)
    );
    await fs.writeFile(
      path.join(testDir, 'test.gif'),
      createMinimalGif(100, 50)
    );
    await fs.writeFile(
      path.join(testDir, 'test.bmp'),
      createMinimalBmp(640, 480)
    );
    await fs.writeFile(
      path.join(testDir, 'test.webp'),
      createMinimalWebp(200, 150)
    );

    // Create a corrupt image (PNG signature but invalid data)
    await fs.writeFile(
      path.join(testDir, 'corrupt.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
    );
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('PNG parsing', () => {
    it('should parse PNG dimensions correctly', async () => {
      const result = await readMediaFile(path.join(testDir, 'test.png'));
      expect(result.mimeType).toBe('image/png');
      expect(result.width).toBe(1);
      expect(result.height).toBe(1);
      expect(result.data).toBeDefined();
    });
  });

  describe('JPEG parsing', () => {
    it('should parse JPEG dimensions correctly', async () => {
      const result = await readMediaFile(path.join(testDir, 'test.jpg'));
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.width).toBe(320);
      expect(result.height).toBe(240);
      expect(result.data).toBeDefined();
    });
  });

  describe('GIF parsing', () => {
    it('should parse GIF dimensions correctly', async () => {
      const result = await readMediaFile(path.join(testDir, 'test.gif'));
      expect(result.mimeType).toBe('image/gif');
      expect(result.width).toBe(100);
      expect(result.height).toBe(50);
      expect(result.data).toBeDefined();
    });
  });

  describe('BMP parsing', () => {
    it('should parse BMP dimensions correctly', async () => {
      const result = await readMediaFile(path.join(testDir, 'test.bmp'));
      expect(result.mimeType).toBe('image/bmp');
      expect(result.width).toBe(640);
      expect(result.height).toBe(480);
      expect(result.data).toBeDefined();
    });
  });

  describe('WebP parsing', () => {
    it('should parse WebP dimensions correctly', async () => {
      const result = await readMediaFile(path.join(testDir, 'test.webp'));
      expect(result.mimeType).toBe('image/webp');
      expect(result.width).toBe(200);
      expect(result.height).toBe(150);
      expect(result.data).toBeDefined();
    });
  });

  describe('corrupt image handling', () => {
    it('should handle corrupt PNG gracefully (no dimensions)', async () => {
      const result = await readMediaFile(path.join(testDir, 'corrupt.png'));
      expect(result.mimeType).toBe('image/png');
      // Corrupt images should not throw but may not have dimensions
      expect(result.data).toBeDefined();
      // Width/height may be undefined or 0 for corrupt images
    });
  });
});
