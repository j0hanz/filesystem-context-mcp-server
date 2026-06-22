import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';

const WINDOWS_PATH_SEPARATOR = /\\/gu;

/**
 * Encapsulates platform-agnostic display path formatting and standard relative/basename calculations.
 */
export const PathFormatter = {
  /**
   * Returns a relative path from "from" to "to", formatted with platform-agnostic forward slashes.
   */
  relative(from: string, to: string): string {
    const rel = relative(from, to);
    return rel.includes('\\') ? rel.replace(WINDOWS_PATH_SEPARATOR, '/') : rel;
  },

  /**
   * Returns the last portion of a path.
   */
  basename(p: string, ext?: string): string {
    return basename(p, ext);
  },

  /**
   * Returns the directory name of a path.
   */
  dirname(p: string): string {
    return dirname(p);
  },

  /**
   * Joins all given path segments together using the platform-specific separator, then normalizes the resulting path.
   */
  join(...paths: string[]): string {
    return join(...paths);
  },

  /**
   * Resolves a sequence of paths or path segments into an absolute path.
   */
  resolve(...paths: string[]): string {
    return resolve(...paths);
  },

  /**
   * Returns an object whose properties represent significant elements of the path.
   */
  parse(p: string) {
    return parse(p);
  },

  /**
   * The platform-specific path segment separator.
   */
  get sep(): string {
    return sep;
  },
};
