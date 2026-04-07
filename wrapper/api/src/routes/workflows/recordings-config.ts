import { parseBoolean, parseEnum, parseIntWithMinimum } from '../../utils/env-parsing.js';

export type WorkflowRecordingCompression = 'gzip' | 'identity';

export type WorkflowRecordingDatasetMode = 'none' | 'all';

export type WorkflowRecordingConfig = {
  enabled: boolean;
  compression: WorkflowRecordingCompression;
  gzipLevel: number;
  maxPendingWrites: number;
  includePartialOutputs: boolean;
  includeTrace: boolean;
  datasetMode: WorkflowRecordingDatasetMode;
  retentionDays: number;
  maxRunsPerEndpoint: number;
  maxTotalBytes: number;
};

export function getWorkflowRecordingConfig(): WorkflowRecordingConfig {
  const compression = parseEnum(process.env.RIVET_RECORDINGS_COMPRESS, ['gzip', 'identity'], 'gzip');
  const datasetMode = parseEnum(process.env.RIVET_RECORDINGS_DATASET_MODE, ['none', 'all'], 'none');

  return {
    enabled: parseBoolean(process.env.RIVET_RECORDINGS_ENABLED, true),
    compression,
    gzipLevel: Math.min(9, parseIntWithMinimum(process.env.RIVET_RECORDINGS_GZIP_LEVEL, 4, 0)),
    maxPendingWrites: parseIntWithMinimum(process.env.RIVET_RECORDINGS_MAX_PENDING_WRITES, 100, 0),
    includePartialOutputs: parseBoolean(process.env.RIVET_RECORDINGS_INCLUDE_PARTIAL_OUTPUTS, false),
    includeTrace: parseBoolean(process.env.RIVET_RECORDINGS_INCLUDE_TRACE, false),
    datasetMode,
    retentionDays: parseIntWithMinimum(process.env.RIVET_RECORDINGS_RETENTION_DAYS, 14, 0),
    maxRunsPerEndpoint: parseIntWithMinimum(process.env.RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT, 100, 0),
    maxTotalBytes: parseIntWithMinimum(process.env.RIVET_RECORDINGS_MAX_TOTAL_BYTES, 0, 0),
  };
}

export function isWorkflowRecordingEnabled(): boolean {
  return getWorkflowRecordingConfig().enabled;
}

export function getWorkflowExecutionRecorderOptions() {
  const config = getWorkflowRecordingConfig();
  return {
    includePartialOutputs: config.includePartialOutputs,
    includeTrace: config.includeTrace,
  };
}

export function shouldSnapshotWorkflowRecordingDatasets(): boolean {
  return getWorkflowRecordingConfig().datasetMode === 'all';
}
