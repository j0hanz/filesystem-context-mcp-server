import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const REPORT = JSON.parse(readFileSync('check-mcp-types-report-all.json', 'utf8')) as {
  used: { name: string; group: string }[];
};

test('used MCP core context/task symbols are categorized', () => {
  const required = [
    'ServerContext',
    'CreateTaskServerContext',
    'TaskServerContext',
    'StandardSchemaWithJSON',
    'TaskStore',
    'RequestTaskStore',
  ];

  const offenders = REPORT.used.filter(
    (u) => required.includes(u.name) && u.group === 'Uncategorized (new types)',
  );

  assert.deepEqual(offenders, []);
});
