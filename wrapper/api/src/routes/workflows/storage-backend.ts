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

async function delegate<T>(
  managedFn: (backend: ManagedWorkflowBackend) => Promise<T>,
  fsFn: () => Promise<T>,
): Promise<T> {
  if (isManagedWorkflowStorageEnabled()) {
    const backend = await getManagedBackend();
    return managedFn(backend);
  }

  return fsFn();
}

async function delegateWithWorkflowsRoot<T>(
  managedFn: (backend: ManagedWorkflowBackend) => Promise<T>,
  fsFn: (root: string) => Promise<T>,
): Promise<T> {
  return delegate(managedFn, async () => fsFn(await ensureWorkflowsRoot()));
}

export async function initializeWorkflowStorage(): Promise<void> {
  await delegate(
    async () => {
      await getManagedBackend();
    },
    async () => {
      const root = await ensureWorkflowsRoot();
      await initializeWorkflowRecordingStorage(root);
    },
  );
}

export async function getWorkflowTree() {
  return delegateWithWorkflowsRoot(
    async (backend) => backend.getTree(),
    async (root) => ({
      root,
      folders: await listWorkflowFolders(root),
      projects: await listWorkflowProjects(root),
    }),
  );
}

export async function listHostedProjectPaths(): Promise<string[]> {
  return delegateWithWorkflowsRoot(
    async (backend) => backend.listProjectPathsForHostedIo(),
    async (root) => {
      const projects = await listWorkflowProjects(root);
      const folders = await listWorkflowFolders(root);
      const nestedProjects = folders.flatMap(function flatten(folder): WorkflowProjectItem[] {
        return [...folder.projects, ...folder.folders.flatMap(flatten)];
      });
      return [...projects, ...nestedProjects].map((project) => project.absolutePath);
    },
  );
}

export async function loadHostedProject(projectPath: string): Promise<LoadHostedProjectResult> {
  return delegate<LoadHostedProjectResult>(
    async (backend) => backend.loadHostedProject(projectPath),
    async () => {
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
    },
  );
}

export async function saveHostedProject(options: {
  projectPath: string;
  contents: string;
  datasetsContents: string | null;
  expectedRevisionId?: string | null;
}): Promise<SaveHostedProjectResult> {
  return delegate<SaveHostedProjectResult>(
    async (backend) => backend.saveHostedProject(options),
    async () => {
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
    },
  );
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
  return delegateWithWorkflowsRoot(
    async (backend) => backend.listWorkflowRecordingWorkflows(),
    async (root) => listWorkflowRecordingWorkflows(root),
  );
}

export async function listWorkflowRecordingRunsPageWithBackend(
  workflowId: string,
  page: number,
  pageSize: number,
  statusFilter: WorkflowRecordingFilterStatus,
): Promise<WorkflowRecordingRunsPageResponse> {
  return delegateWithWorkflowsRoot(
    async (backend) => backend.listWorkflowRecordingRunsPage(workflowId, page, pageSize, statusFilter),
    async (root) => listWorkflowRecordingRunsPage(root, workflowId, page, pageSize, statusFilter),
  );
}

export async function readWorkflowRecordingArtifactWithBackend(recordingId: string, artifact: 'recording' | 'replay-project' | 'replay-dataset'): Promise<string> {
  return delegateWithWorkflowsRoot(
    async (backend) => backend.readWorkflowRecordingArtifact(recordingId, artifact),
    async (root) => readWorkflowRecordingArtifact(root, recordingId, artifact),
  );
}

export async function deleteWorkflowRecordingWithBackend(recordingId: string): Promise<void> {
  await delegateWithWorkflowsRoot(
    async (backend) => backend.deleteWorkflowRecording(recordingId),
    async (root) => deleteWorkflowRecording(root, recordingId),
  );
}

export async function moveWorkflowItemWithBackend(
  itemType: 'project' | 'folder',
  sourceRelativePath: unknown,
  destinationFolderRelativePath: unknown,
): Promise<{ folder?: WorkflowFolderItem; project?: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
  return delegateWithWorkflowsRoot(
    async (backend) => itemType === 'project'
      ? backend.moveWorkflowProject(sourceRelativePath, destinationFolderRelativePath)
      : backend.moveWorkflowFolder(sourceRelativePath, destinationFolderRelativePath),
    async (root) => itemType === 'project'
      ? moveWorkflowProject(root, sourceRelativePath, destinationFolderRelativePath)
      : moveWorkflowFolder(root, sourceRelativePath, destinationFolderRelativePath),
  );
}

export async function createWorkflowFolderItemWithBackend(name: unknown, parentRelativePath: unknown) {
  return delegate(
    async (backend) => backend.createWorkflowFolderItem(name, parentRelativePath),
    async () => createWorkflowFolderItem(name, parentRelativePath),
  );
}

export async function renameWorkflowFolderItemWithBackend(relativePath: unknown, newName: unknown) {
  return delegate(
    async (backend) => backend.renameWorkflowFolderItem(relativePath, newName),
    async () => renameWorkflowFolderItem(relativePath, newName),
  );
}

export async function deleteWorkflowFolderItemWithBackend(relativePath: unknown) {
  return delegate(
    async (backend) => backend.deleteWorkflowFolderItem(relativePath),
    async () => deleteWorkflowFolderItem(relativePath),
  );
}

export async function createWorkflowProjectItemWithBackend(folderRelativePath: unknown, name: unknown) {
  return delegate(
    async (backend) => backend.createWorkflowProjectItem(folderRelativePath, name),
    async () => createWorkflowProjectItem(folderRelativePath, name),
  );
}

export async function renameWorkflowProjectItemWithBackend(relativePath: unknown, newName: unknown) {
  return delegate(
    async (backend) => backend.renameWorkflowProjectItem(relativePath, newName),
    async () => renameWorkflowProjectItem(relativePath, newName),
  );
}

export async function duplicateWorkflowProjectItemWithBackend(relativePath: unknown, version: WorkflowProjectDownloadVersion) {
  return delegate(
    async (backend) => backend.duplicateWorkflowProjectItem(relativePath, version),
    async () => duplicateWorkflowProjectItem(relativePath, version),
  );
}

export async function uploadWorkflowProjectItemWithBackend(folderRelativePath: unknown, fileName: unknown, contents: unknown) {
  return delegate(
    async (backend) => backend.uploadWorkflowProjectItem(folderRelativePath, fileName, contents),
    async () => uploadWorkflowProjectItem(folderRelativePath, fileName, contents),
  );
}

export async function readWorkflowProjectDownloadWithBackend(relativePath: unknown, version: WorkflowProjectDownloadVersion) {
  return delegate(
    async (backend) => backend.readWorkflowProjectDownload(relativePath, version),
    async () => readWorkflowProjectDownload(relativePath, version),
  );
}

export async function publishWorkflowProjectItemWithBackend(relativePath: unknown, settings: WorkflowProjectSettingsDraft | unknown) {
  return delegate(
    async (backend) => backend.publishWorkflowProjectItem(relativePath, settings),
    async () => publishWorkflowProjectItem(relativePath, settings),
  );
}

export async function unpublishWorkflowProjectItemWithBackend(relativePath: unknown) {
  return delegate(
    async (backend) => backend.unpublishWorkflowProjectItem(relativePath),
    async () => unpublishWorkflowProjectItem(relativePath),
  );
}

export async function deleteWorkflowProjectItemWithBackend(relativePath: unknown) {
  return delegate(
    async (backend) => backend.deleteWorkflowProjectItem(relativePath),
    async () => deleteWorkflowProjectItem(relativePath),
  );
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
  return delegateWithWorkflowsRoot(
    async (backend) => backend.createProjectReferenceLoader(),
    async (root) => createPublishedWorkflowProjectReferenceLoader(root, projectPath),
  );
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
