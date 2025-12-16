import type { Buffer } from 'node:buffer';

import type { ImageDimensions, ImageParser } from '../config/types.js';

// Image format signatures
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47] as const;
const JPEG_SIGNATURE = [0xff, 0xd8] as const;
const GIF_SIGNATURE = [0x47, 0x49, 0x46] as const;
const BMP_SIGNATURE = [0x42, 0x4d] as const;
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_MARKER = [0x57, 0x45, 0x42, 0x50] as const;

function matchesSignature(
  buffer: Buffer,
  signature: readonly number[],
  offset = 0
): boolean {
  if (buffer.length < offset + signature.length) return false;
  return signature.every((byte, i) => buffer[offset + i] === byte);
}

function parsePng(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 24 || !matchesSignature(buffer, PNG_SIGNATURE)) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseJpeg(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 2 || !matchesSignature(buffer, JPEG_SIGNATURE)) {
    return null;
  }
  let offset = 2;
  while (offset < buffer.length - 8) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    const isSOF =
      marker !== undefined &&
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf));
    if (isSOF) {
      const width = buffer.readUInt16BE(offset + 7);
      const height = buffer.readUInt16BE(offset + 5);

      // Validate dimensions are reasonable (JPEG spec allows up to 65535x65535)
      if (width <= 0 || height <= 0 || width > 65535 || height > 65535) {
        return null;
      }

      return { width, height };
    }
    if (offset + 3 >= buffer.length) break;
    offset += 2 + buffer.readUInt16BE(offset + 2);
  }
  return null;
}

function parseGif(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 10 || !matchesSignature(buffer, GIF_SIGNATURE)) {
    return null;
  }
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function parseBmp(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 26 || !matchesSignature(buffer, BMP_SIGNATURE)) {
    return null;
  }
  return {
    width: buffer.readInt32LE(18),
    height: Math.abs(buffer.readInt32LE(22)),
  };
}

function parseWebp(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 30) return null;
  if (
    !matchesSignature(buffer, WEBP_RIFF) ||
    !matchesSignature(buffer, WEBP_MARKER, 8)
  ) {
    return null;
  }

  const chunkType = [buffer[12], buffer[13], buffer[14], buffer[15]];
  let width: number;
  let height: number;

  // VP8 (lossy): 0x56 0x50 0x38 0x20
  if (
    chunkType[0] === 0x56 &&
    chunkType[1] === 0x50 &&
    chunkType[2] === 0x38 &&
    chunkType[3] === 0x20
  ) {
    width = buffer.readUInt16LE(26) & 0x3fff;
    height = buffer.readUInt16LE(28) & 0x3fff;
  }
  // VP8L (lossless): 0x56 0x50 0x38 0x4c
  else if (
    chunkType[0] === 0x56 &&
    chunkType[1] === 0x50 &&
    chunkType[2] === 0x38 &&
    chunkType[3] === 0x4c
  ) {
    const bits = buffer.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  }
  // VP8X (extended): 0x56 0x50 0x38 0x58
  else if (
    chunkType[0] === 0x56 &&
    chunkType[1] === 0x50 &&
    chunkType[2] === 0x38 &&
    chunkType[3] === 0x58
  ) {
    width =
      (buffer[24] ?? 0) | ((buffer[25] ?? 0) << 8) | ((buffer[26] ?? 0) << 16);
    height =
      (buffer[27] ?? 0) | ((buffer[28] ?? 0) << 8) | ((buffer[29] ?? 0) << 16);
    width = width + 1;
    height = height + 1;
  } else {
    return null;
  }

  // Validate dimensions are reasonable (max 16384x16384 for WebP spec)
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    return null;
  }

  return { width, height };
}

const IMAGE_PARSERS: Readonly<Record<string, ImageParser>> = {
  '.png': parsePng,
  '.jpg': parseJpeg,
  '.jpeg': parseJpeg,
  '.gif': parseGif,
  '.bmp': parseBmp,
  '.webp': parseWebp,
};

export function parseImageDimensions(
  buffer: Buffer,
  ext: string
): ImageDimensions | null {
  try {
    const parser = IMAGE_PARSERS[ext];
    return parser ? parser(buffer) : null;
  } catch {
    return null;
  }
}
