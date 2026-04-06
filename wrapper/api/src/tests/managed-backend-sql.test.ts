import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { resolveManagedHostedProjectSaveTarget } from '../routes/workflows/managed/backend.js';

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

test('managed save keeps a published project published when the save is a no-op', () => {
  const target = resolveManagedHostedProjectSaveTarget({
    nextContents: {
      contents: 'project: unchanged',
      datasetsContents: null,
    },
    currentDraftContents: {
      contents: 'project: unchanged',
      datasetsContents: null,
    },
    publishedContents: {
      contents: 'project: unchanged',
      datasetsContents: null,
    },
    draftEndpointName: 'published-endpoint',
    publishedEndpointName: 'published-endpoint',
  });

  assert.equal(target, 'published-revision');
});

test('managed save keeps existing unpublished draft state on a no-op save when the draft still differs from published', () => {
  const target = resolveManagedHostedProjectSaveTarget({
    nextContents: {
      contents: 'project: draft-change',
      datasetsContents: null,
    },
    currentDraftContents: {
      contents: 'project: draft-change',
      datasetsContents: null,
    },
    publishedContents: {
      contents: 'project: published',
      datasetsContents: null,
    },
    draftEndpointName: 'published-endpoint',
    publishedEndpointName: 'published-endpoint',
  });

  assert.equal(target, 'current-draft');
});

test('managed save reuses the published revision when the user saves a reverted published state', () => {
  const target = resolveManagedHostedProjectSaveTarget({
    nextContents: {
      contents: 'project: published',
      datasetsContents: 'dataset: published',
    },
    currentDraftContents: {
      contents: 'project: draft-change',
      datasetsContents: 'dataset: draft-change',
    },
    publishedContents: {
      contents: 'project: published',
      datasetsContents: 'dataset: published',
    },
    draftEndpointName: 'published-endpoint',
    publishedEndpointName: 'published-endpoint',
  });

  assert.equal(target, 'published-revision');
});

test('managed save still creates a new revision for real published-project changes', () => {
  const target = resolveManagedHostedProjectSaveTarget({
    nextContents: {
      contents: 'project: new-change',
      datasetsContents: null,
    },
    currentDraftContents: {
      contents: 'project: published',
      datasetsContents: null,
    },
    publishedContents: {
      contents: 'project: published',
      datasetsContents: null,
    },
    draftEndpointName: 'published-endpoint',
    publishedEndpointName: 'published-endpoint',
  });

  assert.equal(target, 'create-revision');
});
