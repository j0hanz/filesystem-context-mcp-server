// Helper function for parsing and validating integer environment variables
function parseEnvInt(
  envVar: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const value = process.env[envVar];
  if (!value) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    console.error(
      `[WARNING] Invalid ${envVar} value: ${value} (must be ${min}-${max}). Using default: ${defaultValue}`
    );
    return defaultValue;
  }

  return parsed;
}

export const PARALLEL_CONCURRENCY = parseEnvInt('PARALLEL_JOBS', 20, 1, 100);
export const DIR_TRAVERSAL_CONCURRENCY = parseEnvInt(
  'TRAVERSAL_JOBS',
  8,
  1,
  50
);
export const REGEX_MATCH_TIMEOUT_MS = parseEnvInt(
  'REGEX_TIMEOUT',
  100,
  50,
  1000
);
export const MAX_SEARCHABLE_FILE_SIZE = parseEnvInt(
  'MAX_SEARCH_SIZE',
  1024 * 1024,
  100 * 1024,
  10 * 1024 * 1024
);
export const MAX_TEXT_FILE_SIZE = parseEnvInt(
  'MAX_FILE_SIZE',
  10 * 1024 * 1024,
  1024 * 1024,
  100 * 1024 * 1024
);
export const MAX_MEDIA_FILE_SIZE = parseEnvInt(
  'MAX_MEDIA_SIZE',
  50 * 1024 * 1024,
  1024 * 1024,
  500 * 1024 * 1024
);

export const MAX_LINE_CONTENT_LENGTH = 200;
export const BINARY_CHECK_BUFFER_SIZE = 512;

export const DEFAULT_MAX_DEPTH = parseEnvInt('DEFAULT_DEPTH', 10, 1, 100);
export const DEFAULT_MAX_RESULTS = parseEnvInt(
  'DEFAULT_RESULTS',
  100,
  10,
  10000
);
export const DEFAULT_TOP_N = parseEnvInt('DEFAULT_TOP', 10, 1, 1000);
export const DEFAULT_TREE_DEPTH = parseEnvInt('DEFAULT_TREE', 5, 1, 50);
export const DEFAULT_TREE_MAX_FILES = parseEnvInt(
  'DEFAULT_TREE_MAX_FILES',
  5000,
  100,
  200000
);
export const KNOWN_BINARY_EXTENSIONS = new Set([
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

// MIME type mapping optimized for fast lookups using Map
const MIME_TYPES = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.bmp', 'image/bmp'],
  ['.tiff', 'image/tiff'],
  ['.tif', 'image/tiff'],
  ['.avif', 'image/avif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.aac', 'audio/aac'],
  ['.m4a', 'audio/mp4'],
  ['.wma', 'audio/x-ms-wma'],
  ['.opus', 'audio/opus'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.avi', 'video/x-msvideo'],
  ['.mov', 'video/quicktime'],
  ['.wmv', 'video/x-ms-wmv'],
  ['.mkv', 'video/x-matroska'],
  ['.flv', 'video/x-flv'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.log', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.json', 'application/json'],
  ['.jsonc', 'application/json'],
  ['.xml', 'application/xml'],
  ['.yaml', 'text/yaml'],
  ['.yml', 'text/yaml'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.css', 'text/css'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/typescript'],
  ['.zip', 'application/zip'],
  ['.tar', 'application/x-tar'],
  ['.gz', 'application/gzip'],
  ['.7z', 'application/x-7z-compressed'],
  ['.rar', 'application/vnd.rar'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.wasm', 'application/wasm'],
]);

// Function to get MIME type from file extension
export function getMimeType(ext: string): string {
  const lowerExt = ext.toLowerCase();
  return MIME_TYPES.get(lowerExt) ?? 'application/octet-stream';
}
