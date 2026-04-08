import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  loadProjectFromFile,
  serializeDatasets,
  serializeProject,
  type AttachedData,
  type CombinedDataset,
  type Project,
} from '@ironclad/rivet-node';

import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingRunKind,
  WorkflowRecordingRunSummary,
  WorkflowRecordingStatus,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRecordingWorkflowSummary,
} from '../../../../shared/workflow-recording-types.js';
import { createHttpError } from '../../utils/httpError.js';
import {
  countWorkflowRecordingRuns,
  deleteEmptyWorkflowRecordingWorkflows,
  deleteWorkflowRecordingWorkflowRow,
  getWorkflowRecordingRunRow,
  getWorkflowRecordingStorageState,
  getWorkflowRecordingWorkflowRowsBySourceProjectPath,
  listWorkflowRecordingRunRowsByWorkflowId,
  listWorkflowRecordingRunRowsForWorkflow,
  listWorkflowRecordingWorkflowStatsRows,
  resetWorkflowRecordingDatabaseForTests,
  setWorkflowRecordingStorageState,
  upsertWorkflowRecordingRun,
  upsertWorkflowRecordingWorkflow,
  type WorkflowRecordingRunRow,
} from './recordings-db.js';
import { createWorkflowRecordingStore } from './recordings-store.js';
import { getWorkflowRecordingConfig, isWorkflowRecordingEnabled } from './recordings-config.js';
import {
  getWorkflowRecordingBundlePath,
  getWorkflowRecordingMetadataPath,
  listProjectPathsRecursive,
  pathExists,
  PROJECT_EXTENSION,
} from './fs-helpers.js';
import {
  getRecordingArtifactPath,
  readArtifactText,
  serializeArtifact,
  type WorkflowRecordingArtifactKind,
} from './recordings-artifacts.js';
import {
  cleanupWorkflowRecordingStorage,
  deleteRecordingRun,
  rebuildWorkflowRecordingIndex,
  removeEmptyWorkflowProjectRecordingsRoot,
} from './recordings-maintenance.js';
import { type StoredWorkflowRecordingMetadataV2 } from './recordings-metadata.js';
import { getWorkflowProject } from './workflow-query.js';

type PersistWorkflowExecutionRecordingOptions = {
  root: string;
  sourceProject: Project;
  sourceProjectPath: string;
  executedProject: Project;
  executedAttachedData: AttachedData;
  executedDatasets: CombinedDataset[];
  endpointName: string;
  recordingSerialized: string;
  runKind: WorkflowRecordingRunKind;
  status: WorkflowRecordingStatus;
  durationMs: number;
  errorMessage?: string;
};

const workflowRecordingStore = createWorkflowRecordingStore({
  rebuildIndex: rebuildWorkflowRecordingIndex,
  cleanupStorage: cleanupWorkflowRecordingStorage,
  setSchemaVersion: (version) => setWorkflowRecordingStorageState('schema-version', version),
  resetDatabaseForTests: resetWorkflowRecordingDatabaseForTests,
});

export function enqueueWorkflowExecutionRecordingPersistence(task: () => Promise<void>): boolean {
  return workflowRecordingStore.enqueuePersistence(task);
}

function toWorkflowRecordingRunSummary(row: WorkflowRecordingRunRow): WorkflowRecordingRunSummary {
  return {
    id: row.id,
    workflowId: row.workflowId,
    createdAt: row.createdAt,
    runKind: row.runKind,
    status: row.status,
    durationMs: row.durationMs,
    endpointNameAtExecution: row.endpointNameAtExecution,
    errorMessage: row.errorMessage,
    hasReplayDataset: row.hasReplayDataset,
    recordingCompressedBytes: row.recordingCompressedBytes,
    recordingUncompressedBytes: row.recordingUncompressedBytes,
    projectCompressedBytes: row.projectCompressedBytes,
    projectUncompressedBytes: row.projectUncompressedBytes,
    datasetCompressedBytes: row.datasetCompressedBytes,
    datasetUncompressedBytes: row.datasetUncompressedBytes,
  };
}

export async function initializeWorkflowRecordingStorage(root: string): Promise<void> {
  await workflowRecordingStore.ensureStorage(root);
}

export async function listWorkflowRecordingWorkflows(root: string): Promise<WorkflowRecordingWorkflowListResponse> {
  await workflowRecordingStore.ensureStorage(root);

  const recordingWorkflows = await listWorkflowRecordingWorkflowStatsRows();
  const recordingWorkflowByPath = new Map(recordingWorkflows.map((workflow) => [workflow.sourceProjectPath, workflow]));
  const recordingWorkflowById = new Map(recordingWorkflows.map((workflow) => [workflow.workflowId, workflow]));

  const projectPaths = await listProjectPathsRecursive(root);
  const workflows: WorkflowRecordingWorkflowSummary[] = [];

  for (const projectPath of projectPaths) {
    const project = await getWorkflowProject(root, projectPath);
    const workflowByPath = recordingWorkflowByPath.get(projectPath);
    let workflowId = workflowByPath?.workflowId ?? '';

    if (!workflowId) {
      try {
        workflowId = (await loadProjectFromFile(projectPath)).metadata.id ?? '';
      } catch (error) {
        console.warn(`Failed to load workflow project metadata for recordings: ${projectPath}`, error);
      }
    }

    const recordingWorkflow = (workflowId ? recordingWorkflowById.get(workflowId) : undefined) ?? workflowByPath;
    const shouldIncludeProject = Boolean(recordingWorkflow) ||
      (project.settings.status !== 'unpublished' && Boolean(project.settings.endpointName));

    if (!shouldIncludeProject) {
      continue;
    }

    workflows.push({
      workflowId: workflowId || recordingWorkflow?.workflowId || project.absolutePath,
      project,
      latestRunAt: recordingWorkflow?.latestRunAt,
      totalRuns: recordingWorkflow?.totalRuns ?? 0,
      failedRuns: recordingWorkflow?.failedRuns ?? 0,
      suspiciousRuns: recordingWorkflow?.suspiciousRuns ?? 0,
    });
  }

  workflows.sort((left, right) => {
    const latestLeft = left.latestRunAt ?? '';
    const latestRight = right.latestRunAt ?? '';
    if (latestLeft && latestRight && latestLeft !== latestRight) {
      return latestRight.localeCompare(latestLeft);
    }

    if (latestLeft && !latestRight) {
      return -1;
    }

    if (!latestLeft && latestRight) {
      return 1;
    }

    return left.project.name.localeCompare(right.project.name);
  });

  return { workflows };
}

export async function listWorkflowRecordingRunsPage(
  root: string,
  workflowId: string,
  page: number,
  pageSize: number,
  statusFilter: WorkflowRecordingFilterStatus,
): Promise<WorkflowRecordingRunsPageResponse> {
  await workflowRecordingStore.ensureStorage(root);

  const normalizedPage = Math.max(1, Math.floor(page));
  const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const totalRuns = await countWorkflowRecordingRuns(workflowId, statusFilter);
  const rows = await listWorkflowRecordingRunRowsByWorkflowId(workflowId, {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    statusFilter,
  });

  return {
    workflowId,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    totalRuns,
    statusFilter,
    runs: rows.map(toWorkflowRecordingRunSummary),
  };
}

export async function readWorkflowRecordingArtifact(
  root: string,
  recordingId: string,
  artifact: WorkflowRecordingArtifactKind,
): Promise<string> {
  await workflowRecordingStore.ensureStorage(root);

  const row = await getWorkflowRecordingRunRow(recordingId);
  if (!row) {
    throw createHttpError(404, 'Recording not found');
  }

  if (artifact === 'replay-dataset' && !row.hasReplayDataset) {
    throw createHttpError(404, 'Replay dataset not found');
  }

  const filePath = getRecordingArtifactPath(row.bundlePath, artifact, row.encoding);
  if (!await pathExists(filePath)) {
    throw createHttpError(404, 'Recording artifact not found');
  }

  return readArtifactText(filePath, row.encoding);
}

export async function deleteWorkflowRecording(root: string, recordingId: string): Promise<void> {
  await workflowRecordingStore.ensureStorage(root);

  const row = await getWorkflowRecordingRunRow(recordingId);
  if (!row) {
    throw createHttpError(404, 'Recording not found');
  }

  await deleteRecordingRun(row);

  const remainingRuns = await listWorkflowRecordingRunRowsForWorkflow(row.workflowId);
  if (remainingRuns.length === 0) {
    await deleteWorkflowRecordingWorkflowRow(row.workflowId);
    await removeEmptyWorkflowProjectRecordingsRoot(root, row.workflowId);
    return;
  }

  await deleteEmptyWorkflowRecordingWorkflows();
}

export async function persistWorkflowExecutionRecording(
  options: PersistWorkflowExecutionRecordingOptions,
): Promise<void> {
  if (!isWorkflowRecordingEnabled()) {
    return;
  }

  const workflowId = options.sourceProject.metadata.id;
  if (!workflowId) {
    return;
  }

  await workflowRecordingStore.ensureStorage(options.root);

  const config = getWorkflowRecordingConfig();
  const recordingId = `${Date.now()}-${randomUUID()}`;
  const bundlePath = getWorkflowRecordingBundlePath(options.root, workflowId, recordingId);
  const sourceProjectName = path.basename(options.sourceProjectPath, PROJECT_EXTENSION);
  const sourceProjectRelativePath = path.relative(options.root, options.sourceProjectPath).replace(/\\/g, '/');
  const createdAt = new Date().toISOString();
  const replayProject: Project = {
    ...options.executedProject,
    metadata: {
      ...options.executedProject.metadata,
      id: randomUUID() as Project['metadata']['id'],
    },
  };

  try {
    await fs.mkdir(bundlePath, { recursive: true });

    const serializedReplayProject = serializeProject(replayProject, options.executedAttachedData);
    if (typeof serializedReplayProject !== 'string') {
      throw new Error('Serialized replay project is not a string');
    }

    const recordingArtifact = await serializeArtifact(
      options.recordingSerialized,
      config.compression,
      config.gzipLevel,
    );
    const replayProjectArtifact = await serializeArtifact(
      serializedReplayProject,
      config.compression,
      config.gzipLevel,
    );

    const recordingPath = getRecordingArtifactPath(bundlePath, 'recording', config.compression);
    const replayProjectPath = getRecordingArtifactPath(bundlePath, 'replay-project', config.compression);

    await fs.writeFile(recordingPath, recordingArtifact.buffer);
    await fs.writeFile(replayProjectPath, replayProjectArtifact.buffer);

    let datasetArtifact:
      | { buffer: Buffer; compressedBytes: number; uncompressedBytes: number }
      | undefined;
    let hasReplayDataset = false;

    if (options.executedDatasets.length > 0) {
      datasetArtifact = await serializeArtifact(
        serializeDatasets(options.executedDatasets),
        config.compression,
        config.gzipLevel,
      );
      await fs.writeFile(getRecordingArtifactPath(bundlePath, 'replay-dataset', config.compression), datasetArtifact.buffer);
      hasReplayDataset = true;
    }

    const metadata: StoredWorkflowRecordingMetadataV2 = {
      version: 2,
      id: recordingId,
      workflowId,
      sourceProjectMetadataId: workflowId,
      sourceProjectName,
      sourceProjectPath: options.sourceProjectPath,
      sourceProjectRelativePath,
      endpointNameAtExecution: options.endpointName,
      createdAt,
      runKind: options.runKind,
      status: options.status,
      durationMs: Math.max(0, Math.round(options.durationMs)),
      encoding: config.compression,
      hasReplayDataset,
      recordingCompressedBytes: recordingArtifact.compressedBytes,
      recordingUncompressedBytes: recordingArtifact.uncompressedBytes,
      projectCompressedBytes: replayProjectArtifact.compressedBytes,
      projectUncompressedBytes: replayProjectArtifact.uncompressedBytes,
      datasetCompressedBytes: datasetArtifact?.compressedBytes ?? 0,
      datasetUncompressedBytes: datasetArtifact?.uncompressedBytes ?? 0,
      errorMessage: options.errorMessage,
    };

    await fs.writeFile(
      getWorkflowRecordingMetadataPath(bundlePath),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8',
    );

    await upsertWorkflowRecordingWorkflow({
      workflowId,
      sourceProjectMetadataId: workflowId,
      sourceProjectPath: options.sourceProjectPath,
      sourceProjectRelativePath,
      sourceProjectName,
      updatedAt: createdAt,
    });
    await upsertWorkflowRecordingRun({
      id: recordingId,
      workflowId,
      createdAt,
      runKind: options.runKind,
      status: options.status,
      durationMs: Math.max(0, Math.round(options.durationMs)),
      endpointNameAtExecution: options.endpointName,
      errorMessage: options.errorMessage,
      bundlePath,
      encoding: config.compression,
      hasReplayDataset,
      recordingCompressedBytes: recordingArtifact.compressedBytes,
      recordingUncompressedBytes: recordingArtifact.uncompressedBytes,
      projectCompressedBytes: replayProjectArtifact.compressedBytes,
      projectUncompressedBytes: replayProjectArtifact.uncompressedBytes,
      datasetCompressedBytes: datasetArtifact?.compressedBytes ?? 0,
      datasetUncompressedBytes: datasetArtifact?.uncompressedBytes ?? 0,
    });

    workflowRecordingStore.scheduleCleanup();
  } catch (error) {
    await fs.rm(bundlePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function deleteWorkflowRecordingsBySourceProjectPath(root: string, projectPath: string): Promise<void> {
  await workflowRecordingStore.ensureStorage(root);

  const relativePath = path.relative(root, projectPath).replace(/\\/g, '/');
  const workflows = await getWorkflowRecordingWorkflowRowsBySourceProjectPath(projectPath, relativePath);

  for (const workflow of workflows) {
    const runs = await listWorkflowRecordingRunRowsForWorkflow(workflow.workflowId);
    for (const run of runs) {
      await deleteRecordingRun(run);
    }

    await deleteWorkflowRecordingWorkflowRow(workflow.workflowId);

    await removeEmptyWorkflowProjectRecordingsRoot(root, workflow.workflowId);
  }

  await deleteEmptyWorkflowRecordingWorkflows();
}

export async function deleteWorkflowRecordingsByWorkflowId(
  root: string,
  workflowId: string | null | undefined,
): Promise<void> {
  if (!workflowId) {
    return;
  }

  await workflowRecordingStore.ensureStorage(root);

  const runs = await listWorkflowRecordingRunRowsForWorkflow(workflowId);
  for (const run of runs) {
    await deleteRecordingRun(run);
  }

  await deleteWorkflowRecordingWorkflowRow(workflowId);

  await removeEmptyWorkflowProjectRecordingsRoot(root, workflowId);
}

export async function resetWorkflowRecordingStorageForTests(): Promise<void> {
  await workflowRecordingStore.resetForTests();
}

export async function getWorkflowRecordingStorageSchemaVersion(): Promise<string | null> {
  return getWorkflowRecordingStorageState('schema-version');
}
