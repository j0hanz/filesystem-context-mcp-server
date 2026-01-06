import { z } from 'zod';

export const FileTypeSchema = z.enum(['file', 'directory', 'symlink', 'other']);
