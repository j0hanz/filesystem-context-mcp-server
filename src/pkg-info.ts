import packageJsonRaw from '../package.json' with { type: 'json' };

export const pkgInfo = packageJsonRaw as {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly homepage?: string;
};
