import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createWorkflowTestRoots, resetWorkflowTestRoots } from './helpers/workflow-fixtures.js';

const envKeys = [
  'RIVET_WORKSPACE_ROOT',
  'RIVET_WORKFLOWS_ROOT',
  'RIVET_WORKFLOW_RECORDINGS_ROOT',
  'RIVET_APP_DATA_ROOT',
  'RIVET_STORAGE_MODE',
] as const;

const previousEnv = new Map<string, string | undefined>();
for (const key of envKeys) {
  previousEnv.set(key, process.env[key]);
}

const {
  tempRoot,
  workflowsRoot,
  recordingsRoot,
  appDataRoot,
} = await createWorkflowTestRoots('rivet-filesystem-recordings-root-');

process.env.RIVET_WORKSPACE_ROOT = tempRoot;
process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = recordingsRoot;
process.env.RIVET_APP_DATA_ROOT = appDataRoot;
process.env.RIVET_STORAGE_MODE = 'filesystem';

const workflowFs = await import('../routes/workflows/fs-helpers.js');
const workflowMutations = await import('../routes/workflows/workflow-mutations.js');
const workflowRecordings = await import('../routes/workflows/recordings.js');
const workflowRecordingDb = await import('../routes/workflows/recordings-db.js');
const rivetNode = await import('@ironclad/rivet-node');

async function resetFilesystemRoots(): Promise<void> {
  await workflowRecordings.resetWorkflowRecordingStorageForTests();
  await resetWorkflowTestRoots({ workflowsRoot, recordingsRoot, appDataRoot });
}

test.beforeEach(async () => {
  await resetFilesystemRoots();
});

test.after(async () => {
  await workflowRecordings.resetWorkflowRecordingStorageForTests();
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

  for (const key of envKeys) {
    const previousValue = previousEnv.get(key);
    if (previousValue == null) {
      delete process.env[key];
    } else {
      process.env[key] = previousValue;
    }
  }
});

test('workflow and recordings roots initialize separately', async () => {
  await fs.rm(recordingsRoot, { recursive: true, force: true });
  await workflowFs.ensureWorkflowsRoot();
  await workflowRecordings.initializeWorkflowRecordingStorage(workflowsRoot);

  assert.equal(await workflowFs.pathExists(path.join(workflowsRoot, '.published')), true);
  assert.equal(await workflowFs.pathExists(path.join(workflowsRoot, '.recordings')), false);
  assert.equal(await workflowFs.pathExists(recordingsRoot), true);
});

test('filesystem recording persistence writes bundles under the configured recordings root', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'RootSplit');
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);

  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'root-split-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'root-split-recording',
        events: [],
        startTs: 1,
        finishTs: 1,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'latest',
    status: 'succeeded',
    durationMs: 1,
  });

  const projectRecordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(recordingsRoot, loadedProject.metadata.id!);
  const bundleDirectories = (await fs.readdir(projectRecordingsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));

  assert.equal(bundleDirectories.length, 1);
  assert.equal(await workflowFs.pathExists(path.join(workflowsRoot, '.recordings')), false);
  assert.equal(projectRecordingsRoot.startsWith(recordingsRoot), true);
});

test('recordings listing rebuilds the index when on-disk bundles drift from the sqlite index', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DriftRepair');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'drift-repair-endpoint',
  });
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);

  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'drift-repair-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'drift-repair-recording',
        events: [],
        startTs: 1,
        finishTs: 1,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'published',
    status: 'succeeded',
    durationMs: 1,
  });

  await workflowRecordingDb.clearWorkflowRecordingIndex();

  const workflows = await workflowRecordings.listWorkflowRecordingWorkflows(workflowsRoot);
  const repaired = workflows.workflows.find((workflow) => workflow.workflowId === loadedProject.metadata.id);

  assert.ok(repaired);
  assert.equal(repaired.totalRuns, 1);
});
