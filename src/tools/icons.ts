import type { Icon } from '@modelcontextprotocol/sdk/types.js';

const MIME = 'image/svg+xml';

function svgIcon(paths: string): Icon[] {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return [
    {
      src: `data:${MIME};base64,${Buffer.from(svg).toString('base64')}`,
      mimeType: MIME,
    },
  ];
}

/** Document with lines — read, read_many, stat, stat_many, calculate_hash, diff_files */
export const FILE_READ_ICONS: Icon[] = svgIcon(
  '<path d="M4 1h5l4 4v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"/><path d="M9 1v4h4"/><path d="M6 8h4M6 11h3"/>'
);

/** Folder — ls, tree, find, roots */
export const DIRECTORY_ICONS: Icon[] = svgIcon(
  '<path d="M2 4h4l2 2h6v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>'
);

/** Magnifying glass — grep */
export const SEARCH_ICONS: Icon[] = svgIcon(
  '<circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l4 4"/>'
);

/** Pencil — write, edit, apply_patch, search_and_replace */
export const FILE_EDIT_ICONS: Icon[] = svgIcon(
  '<path d="M11 2l3 3-9 9H2v-3z"/>'
);

/** Arrow — mv */
export const FILE_MOVE_ICONS: Icon[] = svgIcon(
  '<path d="M2 8h12M10 4l4 4-4 4"/>'
);

/** Trash — rm */
export const FILE_DELETE_ICONS: Icon[] = svgIcon(
  '<path d="M3 4h10M5.5 4V3h5v1"/><path d="M4 4l.7 9.5h6.6L12 4"/>'
);

/** Folder with plus — mkdir */
export const DIR_CREATE_ICONS: Icon[] = svgIcon(
  '<path d="M2 4h4l2 2h6v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M8 9v3M6.5 10.5h3"/>'
);
