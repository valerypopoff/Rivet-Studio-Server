import assert from 'node:assert/strict';
import test from 'node:test';

import { ManagedWorkflowExecutionCache } from '../routes/workflows/managed/execution-cache.js';

test('workflow-level pointer invalidation removes all cached keys for one workflow only', () => {
  const cache = new ManagedWorkflowExecutionCache({
    endpointPointerLimit: 8,
  });

  cache.setEndpointPointer('published:hello', {
    workflowId: 'workflow-a',
    relativePath: 'hello.rivet-project',
    revisionId: 'revision-1',
  });
  cache.setEndpointPointer('latest:hello', {
    workflowId: 'workflow-a',
    relativePath: 'hello.rivet-project',
    revisionId: 'revision-2',
  });
  cache.setEndpointPointer('published:other', {
    workflowId: 'workflow-b',
    relativePath: 'other.rivet-project',
    revisionId: 'revision-3',
  });

  cache.invalidateWorkflowEndpointPointers('workflow-a');

  assert.equal(cache.getEndpointPointer('published:hello'), null);
  assert.equal(cache.getEndpointPointer('latest:hello'), null);
  assert.deepEqual(cache.getEndpointPointer('published:other'), {
    workflowId: 'workflow-b',
    relativePath: 'other.rivet-project',
    revisionId: 'revision-3',
  });
});

test('revision materialization cache evicts least-recently-used entries by byte budget', () => {
  const cache = new ManagedWorkflowExecutionCache({
    revisionMaterializationBytesLimit: 9,
    maxSingleRevisionBytes: 10,
  });

  cache.setRevisionMaterialization({
    revisionId: 'revision-1',
    contents: '12345',
    datasetsContents: null,
  });
  cache.setRevisionMaterialization({
    revisionId: 'revision-2',
    contents: '67890',
    datasetsContents: null,
  });

  assert.equal(cache.getRevisionMaterialization('revision-1'), null);
  assert.deepEqual(cache.getRevisionMaterialization('revision-2'), {
    revisionId: 'revision-2',
    contents: '67890',
    datasetsContents: null,
  });
});

test('revision materialization cache skips oversized entries', () => {
  const cache = new ManagedWorkflowExecutionCache({
    revisionMaterializationBytesLimit: 32,
    maxSingleRevisionBytes: 4,
  });

  const stored = cache.setRevisionMaterialization({
    revisionId: 'revision-1',
    contents: '12345',
    datasetsContents: null,
  });

  assert.equal(stored, false);
  assert.equal(cache.getRevisionMaterialization('revision-1'), null);
});
