import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
} from '../../shared/workflow-types';

export type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
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
