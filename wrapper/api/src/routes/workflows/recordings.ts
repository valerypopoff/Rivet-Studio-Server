import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import {
  loadProjectFromFile,
  serializeDatasets,
  serializeProject,
  type AttachedData,
  type CombinedDataset,
  type Project,
} from '@ironclad/rivet-node';

import type {
  WorkflowRecordingBlobEncoding,
  WorkflowRecordingFilterStatus,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingRunSummary,
  WorkflowRecordingRunKind,
  WorkflowRecordingStatus,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRecordingWorkflowSummary,
} from '../../../../shared/workflow-recording-types.js';
import { createHttpError } from '../../utils/httpError.js';
import {
  clearWorkflowRecordingIndex,
  countWorkflowRecordingRuns,
  deleteEmptyWorkflowRecordingWorkflows,
  deleteWorkflowRecordingRunRow,
  deleteWorkflowRecordingWorkflowRow,
  getWorkflowRecordingRunRow,
  getWorkflowRecordingStorageState,
  getWorkflowRecordingTotalCompressedBytes,
  getWorkflowRecordingWorkflowRowsBySourceProjectPath,
  listWorkflowRecordingRunRowsByWorkflowId,
  listWorkflowRecordingRunRowsForWorkflow,
  listWorkflowRecordingRunsOlderThan,
  listWorkflowRecordingRunsOldestFirst,
  listWorkflowRecordingWorkflowStatsRows,
  resetWorkflowRecordingDatabaseForTests,
  setWorkflowRecordingStorageState,
  upsertWorkflowRecordingRun,
  upsertWorkflowRecordingWorkflow,
  type WorkflowRecordingRunRow,
} from './recordings-db.js';
import { getWorkflowRecordingConfig, isWorkflowRecordingEnabled } from './recordings-config.js';
import {
  getWorkflowProjectRecordingsRoot,
  getWorkflowRecordingsRoot,
  getWorkflowRecordingBundlePath,
  getWorkflowRecordingMetadataPath,
  getWorkflowRecordingPath,
  getWorkflowRecordingReplayDatasetPath,
  getWorkflowRecordingReplayProjectPath,
  listProjectPathsRecursive,
  pathExists,
  PROJECT_EXTENSION,
} from './fs-helpers.js';
import { getWorkflowProject } from './workflow-query.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

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

type WorkflowRecordingArtifactKind = 'recording' | 'replay-project' | 'replay-dataset';
type WorkflowRecordingPersistenceTask = () => Promise<void>;

type StoredWorkflowRecordingMetadataV2 = {
  version: 2;
  id: string;
  workflowId: string;
  sourceProjectMetadataId: string;
  sourceProjectName: string;
  sourceProjectPath: string;
  sourceProjectRelativePath: string;
  endpointNameAtExecution: string;
  createdAt: string;
  runKind: WorkflowRecordingRunKind;
  status: WorkflowRecordingStatus;
  durationMs: number;
  encoding: WorkflowRecordingBlobEncoding;
  hasReplayDataset: boolean;
  recordingCompressedBytes: number;
  recordingUncompressedBytes: number;
  projectCompressedBytes: number;
  projectUncompressedBytes: number;
  datasetCompressedBytes: number;
  datasetUncompressedBytes: number;
  errorMessage?: string;
};

type StoredWorkflowRecordingMetadataV1 = {
  version: 1;
  id: string;
  sourceProjectMetadataId: string;
  sourceProjectName: string;
  sourceProjectPath: string;
  sourceProjectRelativePath: string;
  endpointNameAtExecution: string;
  createdAt: string;
  runKind: WorkflowRecordingRunKind;
  status: WorkflowRecordingStatus;
  durationMs: number;
  recordingPath: string;
  replayProjectPath: string;
  errorMessage?: string;
};

type NormalizedStoredWorkflowRecording = {
  workflowId: string;
  sourceProjectMetadataId: string;
  sourceProjectName: string;
  sourceProjectPath: string;
  sourceProjectRelativePath: string;
  run: WorkflowRecordingRunRow;
};

let storageReadyPromise: Promise<void> | null = null;
let storageReadyRoot = '';
let cleanupPromise: Promise<void> | null = null;
let cleanupRequested = false;
let persistenceQueue: WorkflowRecordingPersistenceTask[] = [];
let persistenceQueuePromise: Promise<void> | null = null;
let lastDroppedPersistenceLogAt = 0;

const PERSISTENCE_DROP_LOG_INTERVAL_MS = 60_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.round(value));
}

function normalizeRunKind(value: unknown): WorkflowRecordingRunKind | null {
  return value === 'published' || value === 'latest' ? value : null;
}

function normalizeStatus(value: unknown): WorkflowRecordingStatus | null {
  return value === 'succeeded' || value === 'failed' ? value : null;
}

function normalizeEncoding(value: unknown): WorkflowRecordingBlobEncoding {
  return value === 'identity' ? 'identity' : 'gzip';
}

function getRecordingArtifactPath(
  bundlePath: string,
  artifact: WorkflowRecordingArtifactKind,
  encoding: WorkflowRecordingBlobEncoding,
): string {
  switch (artifact) {
    case 'recording':
      return getWorkflowRecordingPath(bundlePath, encoding);
    case 'replay-project':
      return getWorkflowRecordingReplayProjectPath(bundlePath, encoding);
    case 'replay-dataset':
      return getWorkflowRecordingReplayDatasetPath(bundlePath, encoding);
  }
}

function getCompressedBundleSize(run: Pick<
  WorkflowRecordingRunRow,
  'recordingCompressedBytes' | 'projectCompressedBytes' | 'datasetCompressedBytes'
>): number {
  return run.recordingCompressedBytes + run.projectCompressedBytes + run.datasetCompressedBytes;
}

async function readArtifactBytes(filePath: string, encoding: WorkflowRecordingBlobEncoding): Promise<{ compressedBytes: number; uncompressedBytes: number }> {
  const buffer = await fs.readFile(filePath);
  if (encoding === 'identity') {
    return {
      compressedBytes: buffer.byteLength,
      uncompressedBytes: buffer.byteLength,
    };
  }

  const uncompressed = await gunzipAsync(buffer);
  return {
    compressedBytes: buffer.byteLength,
    uncompressedBytes: uncompressed.byteLength,
  };
}

async function serializeArtifact(
  text: string,
  encoding: WorkflowRecordingBlobEncoding,
  gzipLevel: number,
): Promise<{ buffer: Buffer; compressedBytes: number; uncompressedBytes: number }> {
  const uncompressed = Buffer.from(text, 'utf8');
  if (encoding === 'identity') {
    return {
      buffer: uncompressed,
      compressedBytes: uncompressed.byteLength,
      uncompressedBytes: uncompressed.byteLength,
    };
  }

  const compressed = await gzipAsync(uncompressed, { level: gzipLevel });
  return {
    buffer: compressed,
    compressedBytes: compressed.byteLength,
    uncompressedBytes: uncompressed.byteLength,
  };
}

async function readArtifactText(filePath: string, encoding: WorkflowRecordingBlobEncoding): Promise<string> {
  const buffer = await fs.readFile(filePath);
  if (encoding === 'identity') {
    return buffer.toString('utf8');
  }

  const text = await gunzipAsync(buffer);
  return text.toString('utf8');
}

async function normalizeStoredWorkflowRecording(
  bundlePath: string,
  value: unknown,
): Promise<NormalizedStoredWorkflowRecording | null> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;

  if (raw.version === 2) {
    const durationMs = normalizeNumber(raw.durationMs);
    const runKind = normalizeRunKind(raw.runKind);
    const status = normalizeStatus(raw.status);

    if (
      !isNonEmptyString(raw.id) ||
      !isNonEmptyString(raw.workflowId) ||
      !isNonEmptyString(raw.sourceProjectMetadataId) ||
      !isNonEmptyString(raw.sourceProjectName) ||
      !isNonEmptyString(raw.sourceProjectPath) ||
      !isNonEmptyString(raw.sourceProjectRelativePath) ||
      !isNonEmptyString(raw.endpointNameAtExecution) ||
      !isNonEmptyString(raw.createdAt) ||
      durationMs == null ||
      runKind == null ||
      status == null
    ) {
      return null;
    }

    return {
      workflowId: raw.workflowId,
      sourceProjectMetadataId: raw.sourceProjectMetadataId,
      sourceProjectName: raw.sourceProjectName,
      sourceProjectPath: raw.sourceProjectPath,
      sourceProjectRelativePath: raw.sourceProjectRelativePath,
      run: {
        id: raw.id,
        workflowId: raw.workflowId,
        createdAt: raw.createdAt,
        runKind,
        status,
        durationMs,
        endpointNameAtExecution: raw.endpointNameAtExecution,
        errorMessage: typeof raw.errorMessage === 'string' && raw.errorMessage.trim() ? raw.errorMessage : undefined,
        bundlePath,
        encoding: normalizeEncoding(raw.encoding),
        hasReplayDataset: raw.hasReplayDataset === true,
        recordingCompressedBytes: normalizeNumber(raw.recordingCompressedBytes) ?? 0,
        recordingUncompressedBytes: normalizeNumber(raw.recordingUncompressedBytes) ?? 0,
        projectCompressedBytes: normalizeNumber(raw.projectCompressedBytes) ?? 0,
        projectUncompressedBytes: normalizeNumber(raw.projectUncompressedBytes) ?? 0,
        datasetCompressedBytes: normalizeNumber(raw.datasetCompressedBytes) ?? 0,
        datasetUncompressedBytes: normalizeNumber(raw.datasetUncompressedBytes) ?? 0,
      },
    };
  }

  if (raw.version === 1) {
    const legacy = raw as Partial<StoredWorkflowRecordingMetadataV1>;
    const durationMs = normalizeNumber(legacy.durationMs);
    const runKind = normalizeRunKind(legacy.runKind);
    const status = normalizeStatus(legacy.status);
    if (
      !isNonEmptyString(legacy.id) ||
      !isNonEmptyString(legacy.sourceProjectMetadataId) ||
      !isNonEmptyString(legacy.sourceProjectName) ||
      !isNonEmptyString(legacy.sourceProjectPath) ||
      !isNonEmptyString(legacy.sourceProjectRelativePath) ||
      !isNonEmptyString(legacy.endpointNameAtExecution) ||
      !isNonEmptyString(legacy.createdAt) ||
      durationMs == null ||
      runKind == null ||
      status == null
    ) {
      return null;
    }

    const gzipRecordingPath = getWorkflowRecordingPath(bundlePath, 'gzip');
    const identityRecordingPath = getWorkflowRecordingPath(bundlePath, 'identity');
    const encoding: WorkflowRecordingBlobEncoding = await pathExists(gzipRecordingPath) ? 'gzip' : 'identity';
    const recordingPath = await pathExists(getWorkflowRecordingPath(bundlePath, encoding))
      ? getWorkflowRecordingPath(bundlePath, encoding)
      : await pathExists(identityRecordingPath)
        ? identityRecordingPath
        : gzipRecordingPath;
    const projectPath = await pathExists(getWorkflowRecordingReplayProjectPath(bundlePath, encoding))
      ? getWorkflowRecordingReplayProjectPath(bundlePath, encoding)
      : getWorkflowRecordingReplayProjectPath(bundlePath, 'identity');
    const datasetPath = await pathExists(getWorkflowRecordingReplayDatasetPath(bundlePath, encoding))
      ? getWorkflowRecordingReplayDatasetPath(bundlePath, encoding)
      : getWorkflowRecordingReplayDatasetPath(bundlePath, 'identity');

    const recordingBytes = await readArtifactBytes(recordingPath, encoding).catch(() => ({ compressedBytes: 0, uncompressedBytes: 0 }));
    const projectBytes = await readArtifactBytes(projectPath, encoding).catch(() => ({ compressedBytes: 0, uncompressedBytes: 0 }));
    const datasetExists = await pathExists(datasetPath);
    const datasetBytes = datasetExists
      ? await readArtifactBytes(datasetPath, encoding).catch(() => ({ compressedBytes: 0, uncompressedBytes: 0 }))
      : { compressedBytes: 0, uncompressedBytes: 0 };

    return {
      workflowId: legacy.sourceProjectMetadataId,
      sourceProjectMetadataId: legacy.sourceProjectMetadataId,
      sourceProjectName: legacy.sourceProjectName,
      sourceProjectPath: legacy.sourceProjectPath,
      sourceProjectRelativePath: legacy.sourceProjectRelativePath,
      run: {
        id: legacy.id,
        workflowId: legacy.sourceProjectMetadataId,
        createdAt: legacy.createdAt,
        runKind,
        status,
        durationMs,
        endpointNameAtExecution: legacy.endpointNameAtExecution,
        errorMessage: typeof legacy.errorMessage === 'string' && legacy.errorMessage.trim() ? legacy.errorMessage : undefined,
        bundlePath,
        encoding,
        hasReplayDataset: datasetExists,
        recordingCompressedBytes: recordingBytes.compressedBytes,
        recordingUncompressedBytes: recordingBytes.uncompressedBytes,
        projectCompressedBytes: projectBytes.compressedBytes,
        projectUncompressedBytes: projectBytes.uncompressedBytes,
        datasetCompressedBytes: datasetBytes.compressedBytes,
        datasetUncompressedBytes: datasetBytes.uncompressedBytes,
      },
    };
  }

  return null;
}

async function readStoredWorkflowRecordingMetadata(bundlePath: string): Promise<NormalizedStoredWorkflowRecording | null> {
  try {
    const metadataPath = getWorkflowRecordingMetadataPath(bundlePath);
    const contents = await fs.readFile(metadataPath, 'utf8');
    return await normalizeStoredWorkflowRecording(bundlePath, JSON.parse(contents) as unknown);
  } catch (error) {
    console.warn(`Failed to read workflow recording metadata from ${bundlePath}:`, error);
    return null;
  }
}

async function rebuildWorkflowRecordingIndex(root: string): Promise<void> {
  const recordingsRoot = getWorkflowRecordingsRoot(root);
  await clearWorkflowRecordingIndex();

  if (!await pathExists(recordingsRoot)) {
    return;
  }

  const workflowDirectories = await fs.readdir(recordingsRoot, { withFileTypes: true });
  for (const workflowDirectory of workflowDirectories) {
    if (!workflowDirectory.isDirectory() || workflowDirectory.name.startsWith('.')) {
      continue;
    }

    const workflowRecordingRoot = path.join(recordingsRoot, workflowDirectory.name);
    const bundleDirectories = await fs.readdir(workflowRecordingRoot, { withFileTypes: true });

    for (const bundleDirectory of bundleDirectories) {
      if (!bundleDirectory.isDirectory() || bundleDirectory.name.startsWith('.')) {
        continue;
      }

      const bundlePath = path.join(workflowRecordingRoot, bundleDirectory.name);
      const metadata = await readStoredWorkflowRecordingMetadata(bundlePath);
      if (!metadata) {
        continue;
      }

      await upsertWorkflowRecordingWorkflow({
        workflowId: metadata.workflowId,
        sourceProjectMetadataId: metadata.sourceProjectMetadataId,
        sourceProjectPath: metadata.sourceProjectPath,
        sourceProjectRelativePath: metadata.sourceProjectRelativePath,
        sourceProjectName: metadata.sourceProjectName,
        updatedAt: metadata.run.createdAt,
      });
      await upsertWorkflowRecordingRun(metadata.run);
    }
  }
}

async function deleteRecordingRun(row: WorkflowRecordingRunRow): Promise<void> {
  if (row.bundlePath && await pathExists(row.bundlePath)) {
    await fs.rm(row.bundlePath, { recursive: true, force: true });
  }

  await deleteWorkflowRecordingRunRow(row.id);
}

async function cleanupWorkflowRecordingStorage(): Promise<void> {
  const config = getWorkflowRecordingConfig();
  const rowsToDelete = new Map<string, WorkflowRecordingRunRow>();

  if (config.retentionDays > 0) {
    const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    for (const row of await listWorkflowRecordingRunsOlderThan(cutoff)) {
      rowsToDelete.set(row.id, row);
    }
  }

  if (config.maxRunsPerWorkflow > 0) {
    const workflows = await listWorkflowRecordingWorkflowStatsRows();
    for (const workflow of workflows) {
      const rows = await listWorkflowRecordingRunRowsForWorkflow(workflow.workflowId);
      for (const row of rows.slice(config.maxRunsPerWorkflow)) {
        rowsToDelete.set(row.id, row);
      }
    }
  }

  if (config.maxTotalBytes > 0) {
    let totalBytes = await getWorkflowRecordingTotalCompressedBytes();
    if (totalBytes > config.maxTotalBytes) {
      for (const row of rowsToDelete.values()) {
        totalBytes -= getCompressedBundleSize(row);
      }

      if (totalBytes > config.maxTotalBytes) {
        for (const row of await listWorkflowRecordingRunsOldestFirst()) {
          if (rowsToDelete.has(row.id)) {
            continue;
          }

          rowsToDelete.set(row.id, row);
          totalBytes -= getCompressedBundleSize(row);
          if (totalBytes <= config.maxTotalBytes) {
            break;
          }
        }
      }
    }
  }

  for (const row of rowsToDelete.values()) {
    await deleteRecordingRun(row);
  }

  await deleteEmptyWorkflowRecordingWorkflows();
}

function scheduleWorkflowRecordingCleanup(): void {
  cleanupRequested = true;

  if (cleanupPromise) {
    return;
  }

  cleanupPromise = (async () => {
    while (cleanupRequested) {
      cleanupRequested = false;
      await cleanupWorkflowRecordingStorage();
    }
  })()
    .catch((error) => {
      console.error('[workflow-recordings] Cleanup failed:', error);
    })
    .finally(() => {
      const shouldRunAgain = cleanupRequested;
      cleanupPromise = null;

      if (shouldRunAgain) {
        scheduleWorkflowRecordingCleanup();
      }
    });
}

function logDroppedWorkflowRecordingPersistence(maxPendingWrites: number): void {
  const now = Date.now();
  if (now - lastDroppedPersistenceLogAt < PERSISTENCE_DROP_LOG_INTERVAL_MS) {
    return;
  }

  lastDroppedPersistenceLogAt = now;
  console.warn(
    `[workflow-recordings] Dropping recording persistence because the queue is full (${maxPendingWrites} pending writes). ` +
      'Workflow execution continues normally.',
  );
}

function scheduleWorkflowRecordingPersistenceQueue(): void {
  if (persistenceQueuePromise) {
    return;
  }

  persistenceQueuePromise = (async () => {
    while (persistenceQueue.length > 0) {
      const task = persistenceQueue.shift();
      if (!task) {
        continue;
      }

      try {
        await task();
      } catch (error) {
        console.error('[workflow-recordings] Failed to persist queued recording:', error);
      }
    }
  })().finally(() => {
    persistenceQueuePromise = null;

    if (persistenceQueue.length > 0) {
      scheduleWorkflowRecordingPersistenceQueue();
    }
  });
}

export function enqueueWorkflowExecutionRecordingPersistence(task: WorkflowRecordingPersistenceTask): boolean {
  if (!isWorkflowRecordingEnabled()) {
    return false;
  }

  const { maxPendingWrites } = getWorkflowRecordingConfig();
  if (maxPendingWrites > 0 && persistenceQueue.length >= maxPendingWrites) {
    logDroppedWorkflowRecordingPersistence(maxPendingWrites);
    return false;
  }

  persistenceQueue.push(task);
  scheduleWorkflowRecordingPersistenceQueue();
  return true;
}

async function ensureWorkflowRecordingStorage(root: string): Promise<void> {
  if (storageReadyPromise && storageReadyRoot === root) {
    return storageReadyPromise;
  }

  storageReadyRoot = root;
  storageReadyPromise = (async () => {
    await rebuildWorkflowRecordingIndex(root);
    await cleanupWorkflowRecordingStorage();
    await setWorkflowRecordingStorageState('schema-version', '2');
  })();

  try {
    await storageReadyPromise;
  } catch (error) {
    storageReadyPromise = null;
    storageReadyRoot = '';
    throw error;
  }
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
  await ensureWorkflowRecordingStorage(root);
}

export async function listWorkflowRecordingWorkflows(root: string): Promise<WorkflowRecordingWorkflowListResponse> {
  await ensureWorkflowRecordingStorage(root);

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
  await ensureWorkflowRecordingStorage(root);

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
  await ensureWorkflowRecordingStorage(root);

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

  await ensureWorkflowRecordingStorage(options.root);

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

    const recordingPath = getWorkflowRecordingPath(bundlePath, config.compression);
    const replayProjectPath = getWorkflowRecordingReplayProjectPath(bundlePath, config.compression);

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
      await fs.writeFile(getWorkflowRecordingReplayDatasetPath(bundlePath, config.compression), datasetArtifact.buffer);
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

    scheduleWorkflowRecordingCleanup();
  } catch (error) {
    await fs.rm(bundlePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function deleteWorkflowRecordingsBySourceProjectPath(root: string, projectPath: string): Promise<void> {
  await ensureWorkflowRecordingStorage(root);

  const relativePath = path.relative(root, projectPath).replace(/\\/g, '/');
  const workflows = await getWorkflowRecordingWorkflowRowsBySourceProjectPath(projectPath, relativePath);

  for (const workflow of workflows) {
    const runs = await listWorkflowRecordingRunRowsForWorkflow(workflow.workflowId);
    for (const run of runs) {
      await deleteRecordingRun(run);
    }

    await deleteWorkflowRecordingWorkflowRow(workflow.workflowId);

    const recordingsRoot = getWorkflowProjectRecordingsRoot(root, workflow.workflowId);
    if (await pathExists(recordingsRoot)) {
      await fs.rm(recordingsRoot, { recursive: true, force: true });
    }
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

  await ensureWorkflowRecordingStorage(root);

  const runs = await listWorkflowRecordingRunRowsForWorkflow(workflowId);
  for (const run of runs) {
    await deleteRecordingRun(run);
  }

  await deleteWorkflowRecordingWorkflowRow(workflowId);

  const recordingsRoot = getWorkflowProjectRecordingsRoot(root, workflowId);
  if (await pathExists(recordingsRoot)) {
    await fs.rm(recordingsRoot, { recursive: true, force: true });
  }
}

export async function resetWorkflowRecordingStorageForTests(): Promise<void> {
  const pendingPersistence = persistenceQueuePromise;
  const pendingCleanup = cleanupPromise;

  storageReadyPromise = null;
  storageReadyRoot = '';
  cleanupPromise = null;
  cleanupRequested = false;
  persistenceQueuePromise = null;
  persistenceQueue = [];
  lastDroppedPersistenceLogAt = 0;

  await pendingPersistence?.catch(() => {});
  await pendingCleanup?.catch(() => {});
  await resetWorkflowRecordingDatabaseForTests();
}

export async function getWorkflowRecordingStorageSchemaVersion(): Promise<string | null> {
  return getWorkflowRecordingStorageState('schema-version');
}
