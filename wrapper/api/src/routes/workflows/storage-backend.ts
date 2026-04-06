import { loadProjectAndAttachedDataFromFile } from '@ironclad/rivet-node';

import type {
  WorkflowFolderItem,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettingsDraft,
} from '../../../../shared/workflow-types.js';
import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingWorkflowListResponse,
} from '../../../../shared/workflow-recording-types.js';
import { createHttpError } from '../../utils/httpError.js';
import { getManagedWorkflowStorageConfig, getWorkflowStorageBackendMode, isManagedWorkflowStorageEnabled } from './storage-config.js';
import { ManagedWorkflowBackend } from './managed/backend.js';
import { ensureWorkflowsRoot } from './fs-helpers.js';
import { listWorkflowFolders, listWorkflowProjects, moveWorkflowFolder, moveWorkflowProject } from './workflow-query.js';
import {
  createWorkflowFolderItem,
  createWorkflowProjectItem,
  deleteWorkflowFolderItem,
  deleteWorkflowProjectItem,
  duplicateWorkflowProjectItem,
  publishWorkflowProjectItem,
  renameWorkflowFolderItem,
  renameWorkflowProjectItem,
  uploadWorkflowProjectItem,
  unpublishWorkflowProjectItem,
} from './workflow-mutations.js';
import { readWorkflowProjectDownload } from './workflow-download.js';
import {
  deleteWorkflowRecording,
  initializeWorkflowRecordingStorage,
  listWorkflowRecordingRunsPage,
  listWorkflowRecordingWorkflows,
  persistWorkflowExecutionRecording,
  readWorkflowRecordingArtifact,
} from './recordings.js';
import { findLatestWorkflowByEndpoint, findPublishedWorkflowByEndpoint, createPublishedWorkflowProjectReferenceLoader } from './publication.js';
import { NodeDatasetProvider } from '@ironclad/rivet-node';
import type { AttachedData, Project, CombinedDataset } from '@ironclad/rivet-node';

type SaveHostedProjectResult = {
  path: string;
  revisionId: string | null;
  project: WorkflowProjectItem | null;
  created: boolean;
};

type LoadHostedProjectResult = {
  contents: string;
  datasetsContents: string | null;
  revisionId: string | null;
};

type ExecutionProjectResult = {
  project: Project;
  attachedData: AttachedData;
  datasetProvider: NodeDatasetProvider;
  projectVirtualPath: string;
  debug?: {
    cacheStatus: 'hit' | 'miss' | 'bypass';
    resolveMs: number;
    materializeMs: number;
  };
};

let managedBackendPromise: Promise<ManagedWorkflowBackend> | null = null;

async function getManagedBackend(): Promise<ManagedWorkflowBackend> {
  if (!managedBackendPromise) {
    managedBackendPromise = (async () => {
      const backend = new ManagedWorkflowBackend(getManagedWorkflowStorageConfig());
      await backend.initialize();
      return backend;
    })().catch((error) => {
      managedBackendPromise = null;
      throw error;
    });
  }

  return managedBackendPromise;
}

export async function initializeWorkflowStorage(): Promise<void> {
  if (isManagedWorkflowStorageEnabled()) {
    await getManagedBackend();
    return;
  }

  const root = await ensureWorkflowsRoot();
  await initializeWorkflowRecordingStorage(root);
}

export async function getWorkflowTree() {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).getTree();
  }

  const root = await ensureWorkflowsRoot();
  return {
    root,
    folders: await listWorkflowFolders(root),
    projects: await listWorkflowProjects(root),
  };
}

export async function listHostedProjectPaths(): Promise<string[]> {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).listProjectPathsForHostedIo();
  }

  const root = await ensureWorkflowsRoot();
  const projects = await listWorkflowProjects(root);
  const folders = await listWorkflowFolders(root);
  const nestedProjects = folders.flatMap(function flatten(folder): WorkflowProjectItem[] {
    return [...folder.projects, ...folder.folders.flatMap(flatten)];
  });
  return [...projects, ...nestedProjects].map((project) => project.absolutePath);
}

export async function loadHostedProject(projectPath: string): Promise<LoadHostedProjectResult> {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).loadHostedProject(projectPath);
  }

  const [project, attachedData] = await loadProjectAndAttachedDataFromFile(projectPath);
  void project;
  void attachedData;
  const fs = await import('node:fs/promises');
  const { getWorkflowDatasetPath, pathExists } = await import('./fs-helpers.js');
  const datasetPath = getWorkflowDatasetPath(projectPath);
  const datasetsContents = await pathExists(datasetPath) ? await fs.readFile(datasetPath, 'utf8') : null;

  return {
    contents: await fs.readFile(projectPath, 'utf8'),
    datasetsContents,
    revisionId: null,
  };
}

export async function saveHostedProject(options: {
  projectPath: string;
  contents: string;
  datasetsContents: string | null;
  expectedRevisionId?: string | null;
}): Promise<SaveHostedProjectResult> {
  if (isManagedWorkflowStorageEnabled()) {
    return await (await getManagedBackend()).saveHostedProject(options);
  }

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { getWorkflowDatasetPath } = await import('./fs-helpers.js');

  await fs.mkdir(path.dirname(options.projectPath), { recursive: true });
  await fs.writeFile(options.projectPath, options.contents, 'utf8');

  const datasetPath = getWorkflowDatasetPath(options.projectPath);
  if (options.datasetsContents != null) {
    await fs.writeFile(datasetPath, options.datasetsContents, 'utf8');
  } else {
    await fs.rm(datasetPath, { force: true }).catch(() => {});
  }

  return {
    path: options.projectPath,
    revisionId: null,
    project: null,
    created: false,
  };
}

export async function readManagedHostedText(filePath: string): Promise<string> {
  if (!isManagedWorkflowStorageEnabled()) {
    throw createHttpError(400, 'Managed workflow storage is disabled');
  }

  return (await getManagedBackend()).readHostedText(filePath);
}

export async function managedHostedPathExists(filePath: string): Promise<boolean> {
  if (!isManagedWorkflowStorageEnabled()) {
    return false;
  }

  return (await getManagedBackend()).hostedPathExists(filePath);
}

export async function readManagedHostedRelativeProject(relativeFrom: string, projectFilePath: string): Promise<string> {
  if (!isManagedWorkflowStorageEnabled()) {
    throw createHttpError(400, 'Managed workflow storage is disabled');
  }

  return (await getManagedBackend()).resolveManagedRelativeProjectText(relativeFrom, projectFilePath);
}

export async function listWorkflowRecordingWorkflowsWithBackend(): Promise<WorkflowRecordingWorkflowListResponse> {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).listWorkflowRecordingWorkflows();
  }

  const root = await ensureWorkflowsRoot();
  return listWorkflowRecordingWorkflows(root);
}

export async function listWorkflowRecordingRunsPageWithBackend(
  workflowId: string,
  page: number,
  pageSize: number,
  statusFilter: WorkflowRecordingFilterStatus,
): Promise<WorkflowRecordingRunsPageResponse> {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).listWorkflowRecordingRunsPage(workflowId, page, pageSize, statusFilter);
  }

  const root = await ensureWorkflowsRoot();
  return listWorkflowRecordingRunsPage(root, workflowId, page, pageSize, statusFilter);
}

export async function readWorkflowRecordingArtifactWithBackend(recordingId: string, artifact: 'recording' | 'replay-project' | 'replay-dataset'): Promise<string> {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).readWorkflowRecordingArtifact(recordingId, artifact);
  }

  const root = await ensureWorkflowsRoot();
  return readWorkflowRecordingArtifact(root, recordingId, artifact);
}

export async function deleteWorkflowRecordingWithBackend(recordingId: string): Promise<void> {
  if (isManagedWorkflowStorageEnabled()) {
    await (await getManagedBackend()).deleteWorkflowRecording(recordingId);
    return;
  }

  const root = await ensureWorkflowsRoot();
  await deleteWorkflowRecording(root, recordingId);
}

export async function moveWorkflowItemWithBackend(
  itemType: 'project' | 'folder',
  sourceRelativePath: unknown,
  destinationFolderRelativePath: unknown,
): Promise<{ folder?: WorkflowFolderItem; project?: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
  if (isManagedWorkflowStorageEnabled()) {
    const backend = await getManagedBackend();
    return itemType === 'project'
      ? await backend.moveWorkflowProject(sourceRelativePath, destinationFolderRelativePath)
      : await backend.moveWorkflowFolder(sourceRelativePath, destinationFolderRelativePath);
  }

  const root = await ensureWorkflowsRoot();
  return itemType === 'project'
    ? await moveWorkflowProject(root, sourceRelativePath, destinationFolderRelativePath)
    : await moveWorkflowFolder(root, sourceRelativePath, destinationFolderRelativePath);
}

export async function createWorkflowFolderItemWithBackend(name: unknown, parentRelativePath: unknown) {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).createWorkflowFolderItem(name, parentRelativePath);
  }

  return createWorkflowFolderItem(name, parentRelativePath);
}

export async function renameWorkflowFolderItemWithBackend(relativePath: unknown, newName: unknown) {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).renameWorkflowFolderItem(relativePath, newName);
  }

  return renameWorkflowFolderItem(relativePath, newName);
}

export async function deleteWorkflowFolderItemWithBackend(relativePath: unknown) {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).deleteWorkflowFolderItem(relativePath);
  }

  return deleteWorkflowFolderItem(relativePath);
}

export async function createWorkflowProjectItemWithBackend(folderRelativePath: unknown, name: unknown) {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).createWorkflowProjectItem(folderRelativePath, name);
  }

  return createWorkflowProjectItem(folderRelativePath, name);
}

export async function renameWorkflowProjectItemWithBackend(relativePath: unknown, newName: unknown) {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).renameWorkflowProjectItem(relativePath, newName);
  }

  return renameWorkflowProjectItem(relativePath, newName);
}

export async function duplicateWorkflowProjectItemWithBackend(relativePath: unknown, version: WorkflowProjectDownloadVersion) {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).duplicateWorkflowProjectItem(relativePath, version);
  }

  return duplicateWorkflowProjectItem(relativePath, version);
}

export async function uploadWorkflowProjectItemWithBackend(folderRelativePath: unknown, fileName: unknown, contents: unknown) {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).uploadWorkflowProjectItem(folderRelativePath, fileName, contents);
  }

  return uploadWorkflowProjectItem(folderRelativePath, fileName, contents);
}

export async function readWorkflowProjectDownloadWithBackend(relativePath: unknown, version: WorkflowProjectDownloadVersion) {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).readWorkflowProjectDownload(relativePath, version);
  }

  return readWorkflowProjectDownload(relativePath, version);
}

export async function publishWorkflowProjectItemWithBackend(relativePath: unknown, settings: WorkflowProjectSettingsDraft | unknown) {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).publishWorkflowProjectItem(relativePath, settings);
  }

  return publishWorkflowProjectItem(relativePath, settings);
}

export async function unpublishWorkflowProjectItemWithBackend(relativePath: unknown) {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).unpublishWorkflowProjectItem(relativePath);
  }

  return unpublishWorkflowProjectItem(relativePath);
}

export async function deleteWorkflowProjectItemWithBackend(relativePath: unknown) {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).deleteWorkflowProjectItem(relativePath);
  }

  return deleteWorkflowProjectItem(relativePath);
}

export async function resolvePublishedExecutionProject(endpointName: string): Promise<ExecutionProjectResult | null> {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).loadPublishedExecutionProject(endpointName);
  }

  const root = await ensureWorkflowsRoot();
  const match = await findPublishedWorkflowByEndpoint(root, endpointName);
  if (!match) {
    return null;
  }

  const [project, attachedData] = await loadProjectAndAttachedDataFromFile(match.publishedProjectPath);
  const datasetProvider = await NodeDatasetProvider.fromProjectFile(match.publishedProjectPath);
  return {
    project,
    attachedData,
    datasetProvider,
    projectVirtualPath: match.projectPath,
  };
}

export async function resolveLatestExecutionProject(endpointName: string): Promise<ExecutionProjectResult | null> {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).loadLatestExecutionProject(endpointName);
  }

  const root = await ensureWorkflowsRoot();
  const match = await findLatestWorkflowByEndpoint(root, endpointName);
  if (!match) {
    return null;
  }

  const [project, attachedData] = await loadProjectAndAttachedDataFromFile(match.projectPath);
  const datasetProvider = await NodeDatasetProvider.fromProjectFile(match.projectPath);
  return {
    project,
    attachedData,
    datasetProvider,
    projectVirtualPath: match.projectPath,
  };
}

export async function createExecutionProjectReferenceLoader(projectPath: string) {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).createProjectReferenceLoader();
  }

  const root = await ensureWorkflowsRoot();
  return createPublishedWorkflowProjectReferenceLoader(root, projectPath);
}

export async function persistWorkflowExecutionRecordingWithBackend(options: {
  sourceProject: Project;
  sourceProjectPath: string;
  executedProject: Project;
  executedAttachedData: AttachedData;
  executedDatasets: CombinedDataset[];
  endpointName: string;
  recordingSerialized: string;
  runKind: 'published' | 'latest';
  status: 'succeeded' | 'failed' | 'suspicious';
  durationMs: number;
  errorMessage?: string;
}) {
  if (isManagedWorkflowStorageEnabled()) {
    await (await getManagedBackend()).persistWorkflowExecutionRecording(options);
    return;
  }

  const root = await ensureWorkflowsRoot();
  await persistWorkflowExecutionRecording({ root, ...options });
}

export function getWorkflowStorageMode() {
  return getWorkflowStorageBackendMode();
}
