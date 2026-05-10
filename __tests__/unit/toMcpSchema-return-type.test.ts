import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { z } from 'zod/v4';

import { toMcpSchema } from '../../src/schema.js';

test('McpSchemaPair interface', () => {
  const testSchema = z.object({
    name: z.string().describe('User name'),
    age: z.number().int().positive().describe('User age'),
  });

  const result = toMcpSchema(testSchema);

  // Verify the result is a McpSchemaPair with correct properties
  assert(typeof result === 'object');
  assert(result !== null);
  assert('standard' in result);
  assert('jsonSchema' in result);

  // Verify standard is StandardSchemaWithJSON
  const { standard, jsonSchema } = result;
  assert(typeof standard === 'object');
  assert('~standard' in standard);
  assert('jsonSchema' in standard);

  // Verify jsonSchema is an object with the expected structure
  assert(typeof jsonSchema === 'object');
  assert(jsonSchema !== null);
  assert('type' in jsonSchema);
  assert(jsonSchema.type === 'object');
  assert('properties' in jsonSchema);
  assert(typeof jsonSchema.properties === 'object');

  // Verify properties are correct
  const props = jsonSchema.properties as Record<string, unknown>;
  assert('name' in props);
  assert('age' in props);

  const nameSchema = props.name as Record<string, unknown>;
  assert(nameSchema.type === 'string');
  assert(nameSchema.description === 'User name');

  const ageSchema = props.age as Record<string, unknown>;
  assert(ageSchema.type === 'integer');
  assert(ageSchema.description === 'User age');
});

test('toMcpSchema with augment function', () => {
  const testSchema = z.object({
    email: z.email().describe('Email address'),
  });

  const result = toMcpSchema(testSchema, (s) => {
    const augmented = { ...s } as Record<string, unknown>;
    augmented.custom = 'augmented';
    return augmented;
  });

  const { jsonSchema } = result;
  assert((jsonSchema as Record<string, unknown>).custom === 'augmented');
});

test('McpSchemaPair eliminates need for jsonSchema property cast', () => {
  const testSchema = z.object({
    id: z.uuid().describe('Unique identifier'),
  });

  // The new pattern: destructure and access jsonSchema directly without cast
  const { standard, jsonSchema } = toMcpSchema(testSchema);

  // This should work without any casts
  assert(typeof jsonSchema === 'object');
  assert(jsonSchema !== null);

  // And standard should be usable directly as well
  assert(typeof standard === 'object');
  assert('~standard' in standard);
});

test('toMcpSchema returns equivalent data before and after refactor', () => {
  const testSchema = z.object({
    field1: z.string(),
    field2: z.number().default(42),
  });

  const { standard, jsonSchema } = toMcpSchema(testSchema);

  // The standard should have jsonSchema callables
  assert(typeof standard === 'object');
  const std = standard as unknown as Record<string, unknown>;
  assert('~standard' in std);
  const innerStd = std['~standard'] as Record<string, unknown>;
  assert('jsonSchema' in innerStd);
  const jsCalls = innerStd['jsonSchema'] as Record<string, unknown>;
  assert(typeof jsCalls.input === 'function');
  assert(typeof jsCalls.output === 'function');

  // The extracted jsonSchema should match what the callables return
  const inputResult = (jsCalls.input as () => unknown)();
  assert(JSON.stringify(inputResult) === JSON.stringify(jsonSchema));
});
