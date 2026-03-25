import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
} from '../../shared/workflow-types';
import type {
  WorkflowRecordingGroup,
  WorkflowRecordingItem,
  WorkflowRecordingListResponse,
  WorkflowRecordingRunKind,
  WorkflowRecordingStatus,
} from '../../shared/workflow-recording-types';

export type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
  WorkflowRecordingGroup,
  WorkflowRecordingItem,
  WorkflowRecordingListResponse,
  WorkflowRecordingRunKind,
  WorkflowRecordingStatus,
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
