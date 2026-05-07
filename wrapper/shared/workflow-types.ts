export type WorkflowProjectStatus = 'unpublished' | 'published' | 'unpublished_changes';
export type WorkflowProjectDownloadVersion = 'live' | 'published';

export const MANAGED_WORKFLOW_VIRTUAL_ROOT = '/managed/workflows';
export const WORKFLOW_PROJECT_EXTENSION = '.rivet-project';
export const WORKFLOW_DATASET_EXTENSION = '.rivet-data';

function normalizeWorkflowVirtualRelativePath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

export function getManagedWorkflowVirtualFolderPath(relativePath = ''): string {
  const normalizedRelativePath = normalizeWorkflowVirtualRelativePath(relativePath);
  return normalizedRelativePath
    ? `${MANAGED_WORKFLOW_VIRTUAL_ROOT}/${normalizedRelativePath}`
    : MANAGED_WORKFLOW_VIRTUAL_ROOT;
}

export function getManagedWorkflowVirtualProjectPath(relativePath: string): string {
  return getManagedWorkflowVirtualFolderPath(normalizeWorkflowVirtualRelativePath(relativePath));
}

export function isManagedWorkflowVirtualPath(filePath: string): boolean {
  return filePath === MANAGED_WORKFLOW_VIRTUAL_ROOT || filePath.startsWith(`${MANAGED_WORKFLOW_VIRTUAL_ROOT}/`);
}

export function getManagedWorkflowRelativePathFromVirtualPath(filePath: string): string | null {
  if (!isManagedWorkflowVirtualPath(filePath)) {
    return null;
  }

  const relativePath = filePath.slice(MANAGED_WORKFLOW_VIRTUAL_ROOT.length).replace(/^\/+/, '');
  return normalizeWorkflowVirtualRelativePath(relativePath);
}

export function getManagedWorkflowVirtualDatasetPath(projectVirtualPath: string): string | null {
  if (!projectVirtualPath.endsWith(WORKFLOW_PROJECT_EXTENSION)) {
    return null;
  }

  return `${projectVirtualPath.slice(0, -WORKFLOW_PROJECT_EXTENSION.length)}${WORKFLOW_DATASET_EXTENSION}`;
}

export type WorkflowProjectSettings = {
  status: WorkflowProjectStatus;
  endpointName: string;
  lastPublishedAt: string | null;
};

export type WorkflowProjectSettingsDraft = {
  endpointName: string;
};

export type WorkflowProjectStats = {
  graphCount: number;
  totalNodeCount: number;
};

export type WorkflowProjectItem = {
  id: string;
  name: string;
  fileName: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
  settings: WorkflowProjectSettings;
  stats?: WorkflowProjectStats;
};

export type WorkflowProjectDeleteResponse = {
  deleted: true;
  projectId: string | null;
};

export type WorkflowFolderItem = {
  id: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
  folders: WorkflowFolderItem[];
  projects: WorkflowProjectItem[];
};

export type WorkflowProjectPathMove = {
  fromAbsolutePath: string;
  toAbsolutePath: string;
};
