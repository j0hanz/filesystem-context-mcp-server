import type { Buffer } from 'node:buffer';

interface ImageDimensions {
  width: number;
  height: number;
}

type ImageParser = (buffer: Buffer) => ImageDimensions | null;

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
  return findJpegDimensions(buffer);
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

  const chunkType = readWebpChunkType(buffer);
  if (!chunkType) return null;

  let dimensions: ImageDimensions | null = null;
  switch (chunkType) {
    case 'VP8 ':
      dimensions = parseWebpVp8(buffer);
      break;
    case 'VP8L':
      dimensions = parseWebpVp8l(buffer);
      break;
    case 'VP8X':
      dimensions = parseWebpVp8x(buffer);
      break;
  }

  return validateDimensions(dimensions, 16384);
}

function validateDimensions(
  dimensions: ImageDimensions | null,
  maxSize: number
): ImageDimensions | null {
  if (!dimensions) return null;
  const { width, height } = dimensions;
  if (width <= 0 || height <= 0 || width > maxSize || height > maxSize) {
    return null;
  }
  return dimensions;
}

function isJpegSofMarker(marker: number | undefined): boolean {
  if (marker === undefined) return false;
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function readJpegDimensions(
  buffer: Buffer,
  offset: number
): ImageDimensions | null {
  const width = buffer.readUInt16BE(offset + 7);
  const height = buffer.readUInt16BE(offset + 5);
  return validateDimensions({ width, height }, 65535);
}

function nextJpegOffset(buffer: Buffer, offset: number): number | null {
  if (offset + 3 >= buffer.length) return null;
  return offset + 2 + buffer.readUInt16BE(offset + 2);
}

function findJpegDimensions(buffer: Buffer): ImageDimensions | null {
  let offset = 2;
  while (offset < buffer.length - 8) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];
    if (isJpegSofMarker(marker)) {
      return readJpegDimensions(buffer, offset);
    }

    const next = nextJpegOffset(buffer, offset);
    if (next === null) break;
    offset = next;
  }
  return null;
}

function readWebpChunkType(buffer: Buffer): 'VP8 ' | 'VP8L' | 'VP8X' | null {
  const chunkType = String.fromCharCode(
    buffer[12] ?? 0,
    buffer[13] ?? 0,
    buffer[14] ?? 0,
    buffer[15] ?? 0
  );
  if (chunkType === 'VP8 ' || chunkType === 'VP8L' || chunkType === 'VP8X') {
    return chunkType;
  }
  return null;
}

function parseWebpVp8(buffer: Buffer): ImageDimensions | null {
  const width = buffer.readUInt16LE(26) & 0x3fff;
  const height = buffer.readUInt16LE(28) & 0x3fff;
  return { width, height };
}

function parseWebpVp8l(buffer: Buffer): ImageDimensions | null {
  const bits = buffer.readUInt32LE(21);
  const width = (bits & 0x3fff) + 1;
  const height = ((bits >> 14) & 0x3fff) + 1;
  return { width, height };
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return (
    (buffer[offset] ?? 0) |
    ((buffer[offset + 1] ?? 0) << 8) |
    ((buffer[offset + 2] ?? 0) << 16)
  );
}

function parseWebpVp8x(buffer: Buffer): ImageDimensions | null {
  const width = readUInt24LE(buffer, 24) + 1;
  const height = readUInt24LE(buffer, 27) + 1;
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
