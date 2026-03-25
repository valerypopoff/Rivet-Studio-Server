import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
} from '../../shared/workflow-types';
import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingRunKind,
  WorkflowRecordingRunSummary,
  WorkflowRecordingStatus,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRecordingWorkflowSummary,
} from '../../shared/workflow-recording-types';

export type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
  WorkflowRecordingFilterStatus,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingRunKind,
  WorkflowRecordingRunSummary,
  WorkflowRecordingStatus,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRecordingWorkflowSummary,
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
