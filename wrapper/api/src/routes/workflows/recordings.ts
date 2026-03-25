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
  WorkflowRecordingGroup,
  WorkflowRecordingItem,
  WorkflowRecordingListResponse,
  WorkflowRecordingRunKind,
  WorkflowRecordingStatus,
} from '../../../../shared/workflow-recording-types.js';
import { pathExists } from './fs-helpers.js';
import {
  getWorkflowDatasetPath,
  getWorkflowProjectRecordingsRoot,
  getWorkflowRecordingsRoot,
  getWorkflowRecordingBundlePath,
  getWorkflowRecordingMetadataPath,
  getWorkflowRecordingPath,
  getWorkflowRecordingReplayDatasetPath,
  getWorkflowRecordingReplayProjectPath,
  listProjectPathsRecursive,
  PROJECT_EXTENSION,
} from './fs-helpers.js';
import { getWorkflowProject } from './workflow-query.js';

type StoredWorkflowRecordingMetadata = {
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeStoredWorkflowRecordingMetadata(
  value: unknown,
): StoredWorkflowRecordingMetadata | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const durationMs = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)
    ? Math.max(0, Math.round(raw.durationMs))
    : null;
  const runKind = raw.runKind === 'published' || raw.runKind === 'latest' ? raw.runKind : null;
  const status = raw.status === 'succeeded' || raw.status === 'failed' ? raw.status : null;

  if (
    raw.version !== 1 ||
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.sourceProjectMetadataId) ||
    !isNonEmptyString(raw.sourceProjectName) ||
    !isNonEmptyString(raw.sourceProjectPath) ||
    !isNonEmptyString(raw.sourceProjectRelativePath) ||
    !isNonEmptyString(raw.endpointNameAtExecution) ||
    !isNonEmptyString(raw.createdAt) ||
    runKind == null ||
    status == null ||
    durationMs == null ||
    !isNonEmptyString(raw.recordingPath) ||
    !isNonEmptyString(raw.replayProjectPath)
  ) {
    return null;
  }

  return {
    version: 1,
    id: raw.id,
    sourceProjectMetadataId: raw.sourceProjectMetadataId,
    sourceProjectName: raw.sourceProjectName,
    sourceProjectPath: raw.sourceProjectPath,
    sourceProjectRelativePath: raw.sourceProjectRelativePath,
    endpointNameAtExecution: raw.endpointNameAtExecution,
    createdAt: raw.createdAt,
    runKind,
    status,
    durationMs,
    recordingPath: raw.recordingPath,
    replayProjectPath: raw.replayProjectPath,
    errorMessage: typeof raw.errorMessage === 'string' && raw.errorMessage.trim()
      ? raw.errorMessage
      : undefined,
  };
}

async function readStoredWorkflowRecordingMetadata(filePath: string): Promise<StoredWorkflowRecordingMetadata | null> {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    return normalizeStoredWorkflowRecordingMetadata(JSON.parse(contents) as unknown);
  } catch (error) {
    console.warn(`Failed to read workflow recording metadata from ${filePath}:`, error);
    return null;
  }
}

async function listStoredWorkflowRecordingsForProject(
  root: string,
  sourceProjectMetadataId: string,
): Promise<StoredWorkflowRecordingMetadata[]> {
  const recordingsRoot = getWorkflowProjectRecordingsRoot(root, sourceProjectMetadataId);
  if (!await pathExists(recordingsRoot)) {
    return [];
  }

  const entries = await fs.readdir(recordingsRoot, { withFileTypes: true });
  const metadata = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) =>
        readStoredWorkflowRecordingMetadata(getWorkflowRecordingMetadataPath(path.join(recordingsRoot, entry.name)))),
  );

  return metadata
    .filter((item): item is StoredWorkflowRecordingMetadata => item != null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function toWorkflowRecordingItem(metadata: StoredWorkflowRecordingMetadata): WorkflowRecordingItem {
  return {
    id: metadata.id,
    createdAt: metadata.createdAt,
    runKind: metadata.runKind,
    status: metadata.status,
    durationMs: metadata.durationMs,
    endpointNameAtExecution: metadata.endpointNameAtExecution,
    sourceProjectName: metadata.sourceProjectName,
    sourceProjectPath: metadata.sourceProjectPath,
    sourceProjectRelativePath: metadata.sourceProjectRelativePath,
    recordingPath: metadata.recordingPath,
    replayProjectPath: metadata.replayProjectPath,
    errorMessage: metadata.errorMessage,
  };
}

export async function listWorkflowRecordings(root: string): Promise<WorkflowRecordingListResponse> {
  const projectPaths = await listProjectPathsRecursive(root);
  const groups = await Promise.all(
    projectPaths.map(async (projectPath): Promise<WorkflowRecordingGroup | null> => {
      const project = await getWorkflowProject(root, projectPath);
      let sourceProjectMetadataId = '';
      try {
        const loadedProject = await loadProjectFromFile(projectPath);
        sourceProjectMetadataId = loadedProject.metadata.id ?? '';
      } catch (error) {
        console.warn(`Failed to load workflow project for recordings: ${projectPath}`, error);
      }

      const recordings = sourceProjectMetadataId
        ? (await listStoredWorkflowRecordingsForProject(root, sourceProjectMetadataId)).map(toWorkflowRecordingItem)
        : [];

      const shouldIncludeProject =
        recordings.length > 0 ||
        (project.settings.status !== 'unpublished' && Boolean(project.settings.endpointName));

      if (!shouldIncludeProject) {
        return null;
      }

      return {
        project,
        recordings,
      };
    }),
  );

  return {
    workflows: groups
      .filter((group): group is WorkflowRecordingGroup => group != null)
      .sort((left, right) => {
        const latestLeft = left.recordings[0]?.createdAt ?? '';
        const latestRight = right.recordings[0]?.createdAt ?? '';

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
      }),
  };
}

export async function persistWorkflowExecutionRecording(
  options: PersistWorkflowExecutionRecordingOptions,
): Promise<void> {
  const sourceProjectMetadataId = options.sourceProject.metadata.id;
  if (!sourceProjectMetadataId) {
    return;
  }

  const recordingId = `${Date.now()}-${randomUUID()}`;
  const bundlePath = getWorkflowRecordingBundlePath(options.root, sourceProjectMetadataId, recordingId);
  const recordingPath = getWorkflowRecordingPath(bundlePath);
  const replayProjectPath = getWorkflowRecordingReplayProjectPath(bundlePath);
  const replayDatasetPath = getWorkflowRecordingReplayDatasetPath(bundlePath);
  const metadataPath = getWorkflowRecordingMetadataPath(bundlePath);

  try {
    await fs.mkdir(bundlePath, { recursive: true });

    const replayProject: Project = {
      ...options.executedProject,
      metadata: {
        ...options.executedProject.metadata,
        id: randomUUID() as Project['metadata']['id'],
      },
    };

    const serializedReplayProject = serializeProject(replayProject, options.executedAttachedData);
    if (typeof serializedReplayProject !== 'string') {
      throw new Error('Serialized replay project is not a string');
    }

    await fs.writeFile(replayProjectPath, serializedReplayProject, 'utf8');
    await fs.writeFile(recordingPath, options.recordingSerialized, 'utf8');

    if (options.executedDatasets.length > 0) {
      await fs.writeFile(replayDatasetPath, serializeDatasets(options.executedDatasets), 'utf8');
    }

    const metadata: StoredWorkflowRecordingMetadata = {
      version: 1,
      id: recordingId,
      sourceProjectMetadataId,
      sourceProjectName: path.basename(options.sourceProjectPath, PROJECT_EXTENSION),
      sourceProjectPath: options.sourceProjectPath,
      sourceProjectRelativePath: path.relative(options.root, options.sourceProjectPath).replace(/\\/g, '/'),
      endpointNameAtExecution: options.endpointName,
      createdAt: new Date().toISOString(),
      runKind: options.runKind,
      status: options.status,
      durationMs: Math.max(0, Math.round(options.durationMs)),
      recordingPath,
      replayProjectPath,
      errorMessage: options.errorMessage,
    };

    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  } catch (error) {
    await fs.rm(bundlePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function deleteWorkflowRecordingsBySourceProjectPath(root: string, projectPath: string): Promise<void> {
  const recordingsRoot = getWorkflowRecordingsRoot(root);
  if (!await pathExists(recordingsRoot)) {
    return;
  }

  const projectRelativePath = path.relative(root, projectPath).replace(/\\/g, '/');
  const projectRecordingDirectories = await fs.readdir(recordingsRoot, { withFileTypes: true });

  for (const projectRecordingDirectory of projectRecordingDirectories) {
    if (!projectRecordingDirectory.isDirectory() || projectRecordingDirectory.name.startsWith('.')) {
      continue;
    }

    const projectRecordingRoot = path.join(recordingsRoot, projectRecordingDirectory.name);
    const recordingDirectories = await fs.readdir(projectRecordingRoot, { withFileTypes: true });
    let removedProjectDirectory = false;

    for (const recordingDirectory of recordingDirectories) {
      if (!recordingDirectory.isDirectory() || recordingDirectory.name.startsWith('.')) {
        continue;
      }

      const bundlePath = path.join(projectRecordingRoot, recordingDirectory.name);
      const metadata = await readStoredWorkflowRecordingMetadata(getWorkflowRecordingMetadataPath(bundlePath));

      if (
        metadata?.sourceProjectPath === projectPath ||
        metadata?.sourceProjectRelativePath === projectRelativePath
      ) {
        await fs.rm(projectRecordingRoot, { recursive: true, force: false });
        removedProjectDirectory = true;
        break;
      }
    }

    if (removedProjectDirectory) {
      continue;
    }
  }
}
