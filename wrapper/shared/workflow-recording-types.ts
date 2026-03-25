import type { WorkflowProjectItem } from './workflow-types';

export type WorkflowRecordingRunKind = 'published' | 'latest';

export type WorkflowRecordingStatus = 'succeeded' | 'failed' | 'suspicious';

export type WorkflowRecordingFilterStatus = 'all' | 'failed';

export type WorkflowRecordingBlobEncoding = 'identity' | 'gzip';

export type WorkflowRecordingRunSummary = {
  id: string;
  workflowId: string;
  createdAt: string;
  runKind: WorkflowRecordingRunKind;
  status: WorkflowRecordingStatus;
  durationMs: number;
  endpointNameAtExecution: string;
  errorMessage?: string;
  hasReplayDataset: boolean;
  recordingCompressedBytes: number;
  recordingUncompressedBytes: number;
  projectCompressedBytes: number;
  projectUncompressedBytes: number;
  datasetCompressedBytes: number;
  datasetUncompressedBytes: number;
};

export type WorkflowRecordingWorkflowSummary = {
  workflowId: string;
  project: WorkflowProjectItem;
  latestRunAt?: string;
  totalRuns: number;
  failedRuns: number;
};

export type WorkflowRecordingWorkflowListResponse = {
  workflows: WorkflowRecordingWorkflowSummary[];
};

export type WorkflowRecordingRunsPageResponse = {
  workflowId: string;
  page: number;
  pageSize: number;
  totalRuns: number;
  statusFilter: WorkflowRecordingFilterStatus;
  runs: WorkflowRecordingRunSummary[];
};

export const WORKFLOW_RECORDING_VIRTUAL_PROJECT_PATH_PREFIX = 'recording://';

export function getWorkflowRecordingVirtualProjectPath(recordingId: string): string {
  return `${WORKFLOW_RECORDING_VIRTUAL_PROJECT_PATH_PREFIX}${encodeURIComponent(recordingId)}/replay.rivet-project`;
}

export function getWorkflowRecordingIdFromVirtualProjectPath(filePath: string): string | null {
  if (!filePath.startsWith(WORKFLOW_RECORDING_VIRTUAL_PROJECT_PATH_PREFIX)) {
    return null;
  }

  const remainder = filePath.slice(WORKFLOW_RECORDING_VIRTUAL_PROJECT_PATH_PREFIX.length);
  const slashIndex = remainder.indexOf('/');
  if (slashIndex <= 0) {
    return null;
  }

  const recordingId = remainder.slice(0, slashIndex);
  const fileName = remainder.slice(slashIndex + 1);
  if (fileName !== 'replay.rivet-project') {
    return null;
  }

  try {
    return decodeURIComponent(recordingId);
  } catch {
    return null;
  }
}
