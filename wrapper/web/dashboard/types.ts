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
  projects: WorkflowProjectItem[];
};

export type WorkflowTreeResponse = {
  root: string;
  folders: WorkflowFolderItem[];
};
