import type { WorkflowProjectStatus as SharedWorkflowProjectStatus } from '../../../../shared/workflow-types.js';

export type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
} from '../../../../shared/workflow-types.js';

export type StoredWorkflowProjectSettings = {
  endpointName: string;
  publishedEndpointName: string;
  publishedSnapshotId: string | null;
  publishedStateHash: string | null;
  legacyStatus?: SharedWorkflowProjectStatus;
};

export type PublishedWorkflowMatch = {
  endpointName: string;
  projectPath: string;
  publishedProjectPath: string;
};

export type LatestWorkflowMatch = {
  endpointName: string;
  projectPath: string;
};
