import { Buffer } from 'node:buffer';
import { extname } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

export const MIME_KINDS = ['text', 'binary', 'image', 'audio', 'pdf'] as const;
export type MimeKind = (typeof MIME_KINDS)[number];

export interface MimeInfo {
  mimeType: string;
  kind: MimeKind;
}

// ─── Extension Map ──────────────────────────────────────────────────────────
// Maps file extensions to MIME types (80+ common extensions)

const EXT_MAP: Record<string, { mimeType: string; kind: MimeKind }> = {
  // Text: Web & Markup
  html: { mimeType: 'text/html', kind: 'text' },
  htm: { mimeType: 'text/html', kind: 'text' },
  xml: { mimeType: 'text/xml', kind: 'text' },
  css: { mimeType: 'text/css', kind: 'text' },
  svg: { mimeType: 'image/svg+xml', kind: 'image' },
  md: { mimeType: 'text/markdown', kind: 'text' },
  markdown: { mimeType: 'text/markdown', kind: 'text' },
  mdown: { mimeType: 'text/markdown', kind: 'text' },

  // Text: Programming Languages
  js: { mimeType: 'text/javascript', kind: 'text' },
  mjs: { mimeType: 'text/javascript', kind: 'text' },
  jsx: { mimeType: 'text/jsx', kind: 'text' },
  ts: { mimeType: 'text/typescript', kind: 'text' },
  tsx: { mimeType: 'text/tsx', kind: 'text' },
  py: { mimeType: 'text/x-python', kind: 'text' },
  java: { mimeType: 'text/x-java', kind: 'text' },
  c: { mimeType: 'text/x-c', kind: 'text' },
  cpp: { mimeType: 'text/x-cpp', kind: 'text' },
  cc: { mimeType: 'text/x-cpp', kind: 'text' },
  cxx: { mimeType: 'text/x-cpp', kind: 'text' },
  h: { mimeType: 'text/x-c', kind: 'text' },
  hpp: { mimeType: 'text/x-cpp', kind: 'text' },
  go: { mimeType: 'text/x-go', kind: 'text' },
  rs: { mimeType: 'text/x-rust', kind: 'text' },
  rb: { mimeType: 'text/x-ruby', kind: 'text' },
  php: { mimeType: 'text/x-php', kind: 'text' },
  sh: { mimeType: 'text/x-shellscript', kind: 'text' },
  bash: { mimeType: 'text/x-shellscript', kind: 'text' },
  zsh: { mimeType: 'text/x-shellscript', kind: 'text' },
  ps1: { mimeType: 'text/x-powershell', kind: 'text' },
  sql: { mimeType: 'text/x-sql', kind: 'text' },

  // Text: Data formats
  json: { mimeType: 'application/json', kind: 'text' },
  jsonc: { mimeType: 'application/json', kind: 'text' },
  ndjson: { mimeType: 'application/x-ndjson', kind: 'text' },
  yaml: { mimeType: 'text/yaml', kind: 'text' },
  yml: { mimeType: 'text/yaml', kind: 'text' },
  toml: { mimeType: 'text/toml', kind: 'text' },
  ini: { mimeType: 'text/plain', kind: 'text' },
  cfg: { mimeType: 'text/plain', kind: 'text' },
  conf: { mimeType: 'text/plain', kind: 'text' },
  csv: { mimeType: 'text/csv', kind: 'text' },

  // Text: Diff & Patches
  diff: { mimeType: 'text/x-diff', kind: 'text' },
  patch: { mimeType: 'text/x-diff', kind: 'text' },

  // Text: Documentation
  txt: { mimeType: 'text/plain', kind: 'text' },
  text: { mimeType: 'text/plain', kind: 'text' },
  log: { mimeType: 'text/plain', kind: 'text' },
  rst: { mimeType: 'text/x-rst', kind: 'text' },

  // Image formats
  png: { mimeType: 'image/png', kind: 'image' },
  jpg: { mimeType: 'image/jpeg', kind: 'image' },
  jpeg: { mimeType: 'image/jpeg', kind: 'image' },
  gif: { mimeType: 'image/gif', kind: 'image' },
  webp: { mimeType: 'image/webp', kind: 'image' },
  ico: { mimeType: 'image/x-icon', kind: 'image' },
  bmp: { mimeType: 'image/bmp', kind: 'image' },
  tiff: { mimeType: 'image/tiff', kind: 'image' },
  tif: { mimeType: 'image/tiff', kind: 'image' },

  // Audio formats
  mp3: { mimeType: 'audio/mpeg', kind: 'audio' },
  wav: { mimeType: 'audio/wav', kind: 'audio' },
  flac: { mimeType: 'audio/flac', kind: 'audio' },
  aac: { mimeType: 'audio/aac', kind: 'audio' },
  ogg: { mimeType: 'audio/ogg', kind: 'audio' },
  m4a: { mimeType: 'audio/mp4', kind: 'audio' },

  // PDF
  pdf: { mimeType: 'application/pdf', kind: 'pdf' },

  // Archives
  zip: { mimeType: 'application/zip', kind: 'binary' },
  tar: { mimeType: 'application/x-tar', kind: 'binary' },
  gz: { mimeType: 'application/gzip', kind: 'binary' },
  gzip: { mimeType: 'application/gzip', kind: 'binary' },
  '7z': { mimeType: 'application/x-7z-compressed', kind: 'binary' },
  rar: { mimeType: 'application/x-rar-compressed', kind: 'binary' },
  bz2: { mimeType: 'application/x-bzip2', kind: 'binary' },
  xz: { mimeType: 'application/x-xz', kind: 'binary' },

  // Other binary formats
  wasm: { mimeType: 'application/wasm', kind: 'binary' },
  so: { mimeType: 'application/octet-stream', kind: 'binary' },
  dylib: { mimeType: 'application/octet-stream', kind: 'binary' },
  dll: { mimeType: 'application/octet-stream', kind: 'binary' },
  exe: { mimeType: 'application/octet-stream', kind: 'binary' },
  msi: { mimeType: 'application/octet-stream', kind: 'binary' },
  dmg: { mimeType: 'application/octet-stream', kind: 'binary' },
};

// ─── Magic Signatures ────────────────────────────────────────────────────────
// Detect file types by magic bytes (file signatures)

interface MagicSignature {
  bytes: Buffer;
  offset: number;
  mimeType: string;
  kind: MimeKind;
}

const MAGIC_SIGNATURES: MagicSignature[] = [
  // PNG
  {
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    offset: 0,
    mimeType: 'image/png',
    kind: 'image',
  },
  // JPEG
  {
    bytes: Buffer.from([0xff, 0xd8, 0xff]),
    offset: 0,
    mimeType: 'image/jpeg',
    kind: 'image',
  },
  // GIF 87a and 89a
  {
    bytes: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]),
    offset: 0,
    mimeType: 'image/gif',
    kind: 'image',
  },
  {
    bytes: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
    offset: 0,
    mimeType: 'image/gif',
    kind: 'image',
  },
  // WEBP
  {
    bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]),
    offset: 0,
    mimeType: 'image/webp',
    kind: 'image',
  }, // RIFF header, webp check is more complex
  // PDF
  {
    bytes: Buffer.from([0x25, 0x50, 0x44, 0x46]),
    offset: 0,
    mimeType: 'application/pdf',
    kind: 'pdf',
  }, // %PDF
  // ZIP
  {
    bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    offset: 0,
    mimeType: 'application/zip',
    kind: 'binary',
  }, // PK..
  {
    bytes: Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    offset: 0,
    mimeType: 'application/zip',
    kind: 'binary',
  }, // PK..
  {
    bytes: Buffer.from([0x50, 0x4b, 0x07, 0x08]),
    offset: 0,
    mimeType: 'application/zip',
    kind: 'binary',
  }, // PK..
  // TAR (gzip compressed)
  {
    bytes: Buffer.from([0x1f, 0x8b]),
    offset: 0,
    mimeType: 'application/gzip',
    kind: 'binary',
  },
];

// ─── Helper Functions ───────────────────────────────────────────────────────

export const MIME_SAMPLE_SIZE = 512;

const KNOWN_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.mp3',
  '.wav',
  '.flac',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.sqlite',
  '.db',
  '.wasm',
  '.bin',
  '.dat',
]);

export function isKnownBinaryExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return KNOWN_BINARY_EXTENSIONS.has(ext);
}

function hasUtf16Bom(slice: Buffer): boolean {
  return (
    slice.length >= 2 &&
    ((slice[0] === 0xff && slice[1] === 0xfe) || (slice[0] === 0xfe && slice[1] === 0xff))
  );
}

/**
 * True when `slice` is valid UTF-8 *as a prefix*: `stream: true` parks a
 * multi-byte sequence cut by the sample boundary in the decoder's buffer
 * instead of reporting it, while `fatal: true` still throws on invalid bytes.
 */
function isUtf8Prefix(slice: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(slice, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** Single binary-vs-text verdict, shared by `detectMimeType` and the read path. */
export function isBinarySample(slice: Buffer): boolean {
  if (slice.length === 0) return false;
  if (hasUtf16Bom(slice)) return false;
  if (slice.includes(0)) return true;
  return !isUtf8Prefix(slice);
}

const WEBP_MARKER_BYTES = Buffer.from([0x57, 0x45, 0x42, 0x50]);

function detectByMagic(buffer: Buffer): MimeInfo | null {
  for (const sig of MAGIC_SIGNATURES) {
    const end = sig.offset + sig.bytes.length;
    if (buffer.length >= end) {
      if (buffer.compare(sig.bytes, 0, sig.bytes.length, sig.offset, end) === 0) {
        // Special handling for RIFF (WEBP vs AVI)
        if (sig.mimeType === 'image/webp') {
          if (buffer.length >= 12 && buffer.compare(WEBP_MARKER_BYTES, 0, 4, 8, 12) === 0) {
            return { mimeType: 'image/webp', kind: 'image' };
          }
          continue;
        }
        return { mimeType: sig.mimeType, kind: sig.kind };
      }
    }
  }
  return null;
}

export function detectMimeType(path: string, sample?: Buffer): MimeInfo {
  const lastDot = path.lastIndexOf('.');
  const ext = lastDot > -1 ? path.slice(lastDot + 1).toLowerCase() : '';

  if (ext && Object.hasOwn(EXT_MAP, ext)) {
    const entry = EXT_MAP[ext];
    if (entry !== undefined) {
      return entry;
    }
  }

  // magic bytes then text heuristic
  if (sample) {
    if (sample.length > 0) {
      const magicResult = detectByMagic(sample);
      if (magicResult !== null) return magicResult;
    }
    return isBinarySample(sample.subarray(0, MIME_SAMPLE_SIZE))
      ? { mimeType: 'application/octet-stream', kind: 'binary' }
      : { mimeType: 'text/plain', kind: 'text' };
  }

  // 3. Final fallback
  return { mimeType: 'application/octet-stream', kind: 'binary' };
}

export function detectMimeFromContent(path: string, content: string | Buffer): MimeInfo {
  return detectMimeType(
    path,
    Buffer.isBuffer(content)
      ? content.subarray(0, MIME_SAMPLE_SIZE)
      : Buffer.from(content.slice(0, MIME_SAMPLE_SIZE)),
  );
}
