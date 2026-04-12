import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowRecordingStore } from '../routes/workflows/recordings-store.js';
import { withScopedEnv } from './helpers/runtime-library-harness.js';

const recordingEnvKeys = [
  'RIVET_RECORDINGS_ENABLED',
  'RIVET_RECORDINGS_MAX_PENDING_WRITES',
] as const;

test('recordings store reuses storage initialization for the same root and resets on root changes', async () => {
  const initializedRoots: string[] = [];
  const store = createWorkflowRecordingStore({
    async rebuildIndex(root) {
      initializedRoots.push(`rebuild:${root}`);
    },
    async cleanupStorage() {
      initializedRoots.push('cleanup');
    },
    async setSchemaVersion(version) {
      initializedRoots.push(`schema:${version}`);
    },
    async resetDatabaseForTests() {},
  });

  await store.ensureStorage('/tmp/workflows-a');
  await store.ensureStorage('/tmp/workflows-a');
  await store.ensureStorage('/tmp/workflows-b');

  assert.deepEqual(initializedRoots, [
    'rebuild:/tmp/workflows-a',
    'cleanup',
    'schema:2',
    'rebuild:/tmp/workflows-b',
    'cleanup',
    'schema:2',
  ]);
});

test('recordings store reruns cleanup when a second cleanup request arrives mid-flight', async () => {
  let cleanupCount = 0;
  let releaseFirstCleanup: () => void = () => {};
  const firstCleanup = new Promise<void>((resolve) => {
    releaseFirstCleanup = resolve;
  });

  const store = createWorkflowRecordingStore({
    async rebuildIndex() {},
    async cleanupStorage() {
      cleanupCount += 1;
      if (cleanupCount === 1) {
        await firstCleanup;
      }
    },
    async setSchemaVersion() {},
    async resetDatabaseForTests() {},
  });

  store.scheduleCleanup();
  store.scheduleCleanup();
  releaseFirstCleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(cleanupCount, 2);
});

test('recordings store drops persistence tasks once the configured queue limit is exceeded', async () => {
  await withScopedEnv(recordingEnvKeys, {
    RIVET_RECORDINGS_ENABLED: 'true',
    RIVET_RECORDINGS_MAX_PENDING_WRITES: '1',
  }, async () => {
    let releaseFirstTask: () => void = () => {};
    const firstTask = new Promise<void>((resolve) => {
      releaseFirstTask = resolve;
    });
    const persisted: string[] = [];

    const store = createWorkflowRecordingStore({
      async rebuildIndex() {},
      async cleanupStorage() {},
      async setSchemaVersion() {},
      async resetDatabaseForTests() {},
    });

    const firstAccepted = store.enqueuePersistence(async () => {
      persisted.push('first');
      await firstTask;
    });
    const secondAccepted = store.enqueuePersistence(async () => {
      persisted.push('second');
    });
    const thirdAccepted = store.enqueuePersistence(async () => {
      persisted.push('third');
    });

    assert.equal(firstAccepted, true);
    assert.equal(secondAccepted, true);
    assert.equal(thirdAccepted, false);

    releaseFirstTask();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(persisted, ['first', 'second']);
  });
});
