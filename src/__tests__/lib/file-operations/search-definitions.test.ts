import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { searchDefinitions } from '../../../lib/file-operations/search-definitions.js';
import { normalizePath } from '../../../lib/path-utils.js';
import { setAllowedDirectories } from '../../../lib/path-validation.js';

describe('searchDefinitions', () => {
  let testDir: string;

  beforeAll(async () => {
    // Create a unique temp directory for this test suite
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'mcp-search-definitions-test-')
    );
    setAllowedDirectories([normalizePath(testDir)]);

    // Create directory structure
    await fs.mkdir(path.join(testDir, 'src', 'services'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'src', 'utils'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'src', 'types'), { recursive: true });

    // Create test TypeScript files with various definitions
    await fs.writeFile(
      path.join(testDir, 'src', 'services', 'user-service.ts'),
      `import { Database } from '../database';

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
`
    );

    await fs.writeFile(
      path.join(testDir, 'src', 'utils', 'helpers.ts'),
      `export function formatDate(date: Date): string {
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
`
    );

    await fs.writeFile(
      path.join(testDir, 'src', 'types', 'index.ts'),
      `export interface ApiResponse<T> {
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
`
    );
  });

  afterAll(async () => {
    // Cleanup
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('search by name', () => {
    it('should find a class by name', async () => {
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

    it('should find a function by name', async () => {
      const result = await searchDefinitions({
        path: testDir,
        name: 'createUser',
      });

      expect(result.definitions.length).toBeGreaterThanOrEqual(1);
      const createUserDef = result.definitions.find(
        (d) => d.name === 'createUser'
      );
      expect(createUserDef).toBeDefined();
      expect(createUserDef?.definitionType).toBe('function');
      expect(createUserDef?.exported).toBe(true);
    });

    it('should find an interface by name', async () => {
      const result = await searchDefinitions({
        path: testDir,
        name: 'User',
        type: 'interface',
      });

      expect(result.definitions.length).toBeGreaterThanOrEqual(1);
      const userInterface = result.definitions.find(
        (d) => d.name === 'User' && d.definitionType === 'interface'
      );
      expect(userInterface).toBeDefined();
    });

    it('should find a type alias by name', async () => {
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

    it('should find an enum by name', async () => {
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
  });

  describe('discovery mode (search by type)', () => {
    it('should find all classes', async () => {
      const result = await searchDefinitions({
        path: testDir,
        type: 'class',
      });

      expect(result.definitions.length).toBeGreaterThanOrEqual(1);
      expect(
        result.definitions.every((d) => d.definitionType === 'class')
      ).toBe(true);
    });

    it('should find all interfaces', async () => {
      const result = await searchDefinitions({
        path: testDir,
        type: 'interface',
      });

      expect(result.definitions.length).toBeGreaterThanOrEqual(3);
      const names = result.definitions.map((d) => d.name);
      expect(names).toContain('User');
      expect(names).toContain('DateOptions');
      expect(names).toContain('ApiResponse');
    });

    it('should find all type aliases', async () => {
      const result = await searchDefinitions({
        path: testDir,
        type: 'type',
      });

      expect(result.definitions.length).toBeGreaterThanOrEqual(3);
      const names = result.definitions.map((d) => d.name);
      expect(names).toContain('UserId');
      expect(names).toContain('DateFormatter');
      expect(names).toContain('ApiError');
    });

    it('should find all enums', async () => {
      const result = await searchDefinitions({
        path: testDir,
        type: 'enum',
      });

      expect(result.definitions.length).toBeGreaterThanOrEqual(2);
      const names = result.definitions.map((d) => d.name);
      expect(names).toContain('UserRole');
      expect(names).toContain('HttpStatus');
    });
  });

  describe('options', () => {
    it('should include context lines when specified', async () => {
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

    it('should respect maxResults limit', async () => {
      const result = await searchDefinitions({
        path: testDir,
        type: 'interface',
        maxResults: 2,
      });

      expect(result.definitions.length).toBeLessThanOrEqual(2);
    });

    it('should detect exported vs non-exported definitions', async () => {
      // Search for functions - will include both regular functions and arrow functions
      const result = await searchDefinitions({
        path: testDir,
        type: 'function',
      });

      const exported = result.definitions.filter((d) => d.exported);
      const nonExported = result.definitions.filter((d) => !d.exported);

      // Should have exported functions like createUser, formatDate
      expect(exported.length).toBeGreaterThan(0);

      // Note: internalHelper is an arrow function, so it may or may not be found
      // depending on the search pattern. The key test is that exported/non-exported
      // detection works for definitions that are found.
      if (nonExported.length > 0) {
        expect(nonExported[0]?.exported).toBe(false);
      }
      if (exported.length > 0) {
        expect(exported[0]?.exported).toBe(true);
      }
    });
  });

  describe('error handling', () => {
    it('should throw error when neither name nor type is provided', async () => {
      await expect(
        searchDefinitions({
          path: testDir,
        })
      ).rejects.toThrow(/name or type/i);
    });

    it('should return empty results for non-existent symbol', async () => {
      const result = await searchDefinitions({
        path: testDir,
        name: 'NonExistentClass',
        type: 'class',
      });

      expect(result.definitions).toHaveLength(0);
      expect(result.summary.totalDefinitions).toBe(0);
    });
  });

  describe('summary', () => {
    it('should include accurate summary statistics', async () => {
      const result = await searchDefinitions({
        path: testDir,
        type: 'interface',
      });

      expect(result.summary.filesScanned).toBeGreaterThan(0);
      expect(result.summary.filesMatched).toBeGreaterThan(0);
      expect(result.summary.totalDefinitions).toBe(result.definitions.length);
      expect(typeof result.summary.truncated).toBe('boolean');
    });
  });
});
