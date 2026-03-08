export type WorkflowProjectStatus = 'unpublished' | 'published' | 'unpublished_changes';

export type WorkflowProjectSettings = {
  status: WorkflowProjectStatus;
  endpointName: string;
};

export type WorkflowProjectSettingsDraft = {
  endpointName: string;
};

export type WorkflowProjectItem = {
  id: string;
  name: string;
  fileName: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
  settings: WorkflowProjectSettings;
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

export type WorkflowMoveResponse = {
  folder?: WorkflowFolderItem;
  project?: WorkflowProjectItem;
  movedProjectPaths: WorkflowProjectPathMove[];
};

export type WorkflowTreeResponse = {
  root: string;
  folders: WorkflowFolderItem[];
  projects: WorkflowProjectItem[];
};
