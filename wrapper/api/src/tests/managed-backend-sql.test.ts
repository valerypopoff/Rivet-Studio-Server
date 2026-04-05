import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const managedBackendSource = await fs.readFile(
  new URL('../routes/workflows/managed/backend.ts', import.meta.url),
  'utf8',
);

test('managed folder move SQL escapes wildcard characters in prefix LIKE patterns', () => {
  assert.ok(
    managedBackendSource.includes(
      "source_prefix_pattern TEXT := replace(replace(replace(source_relative_path, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '/%';",
    ),
  );
  assert.ok(
    managedBackendSource.includes(
      "temporary_prefix_pattern TEXT := replace(replace(replace(temporary_prefix, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '/%';",
    ),
  );

  const sourceEscapeMatches = managedBackendSource.match(/LIKE source_prefix_pattern ESCAPE '\\'/g) ?? [];
  const temporaryEscapeMatches = managedBackendSource.match(/LIKE temporary_prefix_pattern ESCAPE '\\'/g) ?? [];

  assert.ok(sourceEscapeMatches.length >= 4, `Expected source prefix LIKE clauses to use ESCAPE, found ${sourceEscapeMatches.length}`);
  assert.ok(
    temporaryEscapeMatches.length >= 4,
    `Expected temporary prefix LIKE clauses to use ESCAPE, found ${temporaryEscapeMatches.length}`,
  );
});
