import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { normalizePath } from '../../../lib/path-utils.js';
import { setAllowedDirectories } from '../../../lib/path-validation.js';

export const USER_SERVICE_TS = `import { Database } from '../database';

export class UserService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async getUser(id: string): Promise<User | null> {
    return this.db.findById(id);
  }
}

export interface User {
  id: string;
  name: string;
  email: string;
}

export type UserId = string;

export const DEFAULT_USER: User = {
  id: '0',
  name: 'Guest',
  email: 'guest@example.com',
};

export enum UserRole {
  Admin = 'admin',
  User = 'user',
  Guest = 'guest',
}

export async function createUser(name: string): Promise<User> {
  return { id: crypto.randomUUID(), name, email: '' };
}

const internalHelper = (x: number) => x * 2;

export const processUser = async (user: User) => {
  return user;
};
`;

export const HELPERS_TS = `export function formatDate(date: Date): string {
  return date.toISOString();
}

export const debounce = <T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
) => {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
};

export interface DateOptions {
  locale?: string;
  timezone?: string;
}

export type DateFormatter = (date: Date, options?: DateOptions) => string;
`;

export const TYPES_TS = `export interface ApiResponse<T> {
  data: T;
  status: number;
  message?: string;
}

export type ApiError = {
  code: string;
  message: string;
};

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export const enum HttpStatus {
  OK = 200,
  Created = 201,
  BadRequest = 400,
  NotFound = 404,
}
`;

export async function createFixtureDirectory(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'mcp-search-definitions-test-')
  );
  setAllowedDirectories([normalizePath(dir)]);
  return dir;
}

export async function writeFixtureFiles(baseDir: string): Promise<void> {
  await fs.mkdir(path.join(baseDir, 'src', 'services'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'src', 'utils'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'src', 'types'), { recursive: true });

  await fs.writeFile(
    path.join(baseDir, 'src', 'services', 'user-service.ts'),
    USER_SERVICE_TS
  );
  await fs.writeFile(
    path.join(baseDir, 'src', 'utils', 'helpers.ts'),
    HELPERS_TS
  );
  await fs.writeFile(path.join(baseDir, 'src', 'types', 'index.ts'), TYPES_TS);
}

export async function removeFixture(baseDir: string): Promise<void> {
  try {
    await fs.rm(baseDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
