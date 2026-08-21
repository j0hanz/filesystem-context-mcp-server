import packageJsonRaw from '../package.json' with { type: 'json' };

export interface PkgInfo {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly homepage?: string;
}

export const pkgInfo: PkgInfo = packageJsonRaw;
