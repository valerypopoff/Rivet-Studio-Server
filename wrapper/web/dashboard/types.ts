export type WorkflowProjectItem = {
  id: string;
  name: string;
  fileName: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
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
