import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { searchDefinitions } from '../../../lib/file-operations/search-definitions.js';
import { normalizePath } from '../../../lib/path-utils.js';
import { setAllowedDirectories } from '../../../lib/path-validation.js';

const USER_SERVICE_TS = `import { Database } from '../database';

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

const HELPERS_TS = `export function formatDate(date: Date): string {
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

const TYPES_TS = `export interface ApiResponse<T> {
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

let testDir = '';

async function createFixtureDirectory(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'mcp-search-definitions-test-')
  );
  setAllowedDirectories([normalizePath(dir)]);
  return dir;
}

async function writeFixtureFiles(baseDir: string): Promise<void> {
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

async function removeFixture(baseDir: string): Promise<void> {
  try {
    await fs.rm(baseDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

beforeAll(async () => {
  testDir = await createFixtureDirectory();
  await writeFixtureFiles(testDir);
});

afterAll(async () => {
  await removeFixture(testDir);
});

it('finds a class by name', async () => {
  const result = await searchDefinitions({
    path: testDir,
    name: 'UserService',
    type: 'class',
  });

  expect(result.definitions).toHaveLength(1);
  expect(result.definitions[0]).toMatchObject({
    name: 'UserService',
    definitionType: 'class',
    exported: true,
  });
  expect(result.definitions[0]?.file).toContain('user-service.ts');
});

it('finds a function by name', async () => {
  const result = await searchDefinitions({
    path: testDir,
    name: 'createUser',
  });

  const createUserDef = result.definitions.find((d) => d.name === 'createUser');
  expect(createUserDef).toBeDefined();
  expect(createUserDef?.definitionType).toBe('function');
  expect(createUserDef?.exported).toBe(true);
});

it('finds an interface by name', async () => {
  const result = await searchDefinitions({
    path: testDir,
    name: 'User',
    type: 'interface',
  });

  const match = result.definitions.find(
    (d) => d.name === 'User' && d.definitionType === 'interface'
  );
  expect(match).toBeDefined();
});

it('finds a type alias by name', async () => {
  const result = await searchDefinitions({
    path: testDir,
    name: 'UserId',
    type: 'type',
  });

  expect(result.definitions).toHaveLength(1);
  expect(result.definitions[0]).toMatchObject({
    name: 'UserId',
    definitionType: 'type',
    exported: true,
  });
});

it('finds an enum by name', async () => {
  const result = await searchDefinitions({
    path: testDir,
    name: 'UserRole',
    type: 'enum',
  });

  expect(result.definitions).toHaveLength(1);
  expect(result.definitions[0]).toMatchObject({
    name: 'UserRole',
    definitionType: 'enum',
    exported: true,
  });
});

it('finds all classes when searching by type', async () => {
  const result = await searchDefinitions({
    path: testDir,
    type: 'class',
  });

  expect(result.definitions.length).toBeGreaterThanOrEqual(1);
  expect(result.definitions.every((d) => d.definitionType === 'class')).toBe(
    true
  );
});

it('finds all interfaces when searching by type', async () => {
  const result = await searchDefinitions({
    path: testDir,
    type: 'interface',
  });

  const names = result.definitions.map((d) => d.name);
  expect(names).toContain('User');
  expect(names).toContain('DateOptions');
  expect(names).toContain('ApiResponse');
});

it('finds all type aliases when searching by type', async () => {
  const result = await searchDefinitions({
    path: testDir,
    type: 'type',
  });

  const names = result.definitions.map((d) => d.name);
  expect(names).toContain('UserId');
  expect(names).toContain('DateFormatter');
  expect(names).toContain('ApiError');
});

it('finds all enums when searching by type', async () => {
  const result = await searchDefinitions({
    path: testDir,
    type: 'enum',
  });

  const names = result.definitions.map((d) => d.name);
  expect(names).toContain('UserRole');
  expect(names).toContain('HttpStatus');
});

it('includes context lines when requested', async () => {
  const result = await searchDefinitions({
    path: testDir,
    name: 'UserService',
    type: 'class',
    contextLines: 2,
  });

  expect(result.definitions).toHaveLength(1);
  expect(result.definitions[0]?.contextBefore).toBeDefined();
  expect(result.definitions[0]?.contextAfter).toBeDefined();
});

it('respects maxResults', async () => {
  const result = await searchDefinitions({
    path: testDir,
    type: 'interface',
    maxResults: 2,
  });

  expect(result.definitions.length).toBeLessThanOrEqual(2);
});

it('detects exported vs non-exported definitions', async () => {
  const result = await searchDefinitions({
    path: testDir,
    type: 'function',
  });

  const exported = result.definitions.filter((d) => d.exported);
  const nonExported = result.definitions.filter((d) => !d.exported);

  expect(exported.length).toBeGreaterThan(0);
  if (nonExported.length > 0) {
    expect(nonExported[0]?.exported).toBe(false);
  }
});

it('throws when neither name nor type is provided', async () => {
  await expect(
    searchDefinitions({
      path: testDir,
    })
  ).rejects.toThrow(/name or type/i);
});

it('returns empty results for non-existent symbol', async () => {
  const result = await searchDefinitions({
    path: testDir,
    name: 'NonExistentClass',
    type: 'class',
  });

  expect(result.definitions).toHaveLength(0);
  expect(result.summary.totalDefinitions).toBe(0);
});

it('includes summary statistics', async () => {
  const result = await searchDefinitions({
    path: testDir,
    type: 'interface',
  });

  expect(result.summary.filesScanned).toBeGreaterThan(0);
  expect(result.summary.filesMatched).toBeGreaterThan(0);
  expect(result.summary.totalDefinitions).toBe(result.definitions.length);
  expect(typeof result.summary.truncated).toBe('boolean');
});
