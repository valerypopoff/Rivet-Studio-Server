import type { WorkflowProjectItem } from './workflow-types';

export type WorkflowRecordingRunKind = 'published' | 'latest';

export type WorkflowRecordingStatus = 'succeeded' | 'failed';

export type WorkflowRecordingItem = {
  id: string;
  createdAt: string;
  runKind: WorkflowRecordingRunKind;
  status: WorkflowRecordingStatus;
  durationMs: number;
  endpointNameAtExecution: string;
  sourceProjectName: string;
  sourceProjectPath: string;
  sourceProjectRelativePath: string;
  recordingPath: string;
  replayProjectPath: string;
  errorMessage?: string;
};

export type WorkflowRecordingGroup = {
  project: WorkflowProjectItem;
  recordings: WorkflowRecordingItem[];
};

export type WorkflowRecordingListResponse = {
  workflows: WorkflowRecordingGroup[];
};
