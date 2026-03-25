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

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parseIntegerEnv(value: string | undefined, defaultValue: number, minimum: number): number {
  if (value == null || !value.trim()) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  return Math.max(minimum, parsed);
}

export function getWorkflowRecordingConfig(): WorkflowRecordingConfig {
  const compression = process.env.RIVET_RECORDINGS_COMPRESS?.trim().toLowerCase() === 'identity'
    ? 'identity'
    : 'gzip';
  const datasetMode = process.env.RIVET_RECORDINGS_DATASET_MODE?.trim().toLowerCase() === 'all'
    ? 'all'
    : 'none';

  return {
    enabled: parseBooleanEnv(process.env.RIVET_RECORDINGS_ENABLED, true),
    compression,
    gzipLevel: Math.min(9, parseIntegerEnv(process.env.RIVET_RECORDINGS_GZIP_LEVEL, 4, 0)),
    maxPendingWrites: parseIntegerEnv(process.env.RIVET_RECORDINGS_MAX_PENDING_WRITES, 100, 0),
    includePartialOutputs: parseBooleanEnv(process.env.RIVET_RECORDINGS_INCLUDE_PARTIAL_OUTPUTS, false),
    includeTrace: parseBooleanEnv(process.env.RIVET_RECORDINGS_INCLUDE_TRACE, false),
    datasetMode,
    retentionDays: parseIntegerEnv(process.env.RIVET_RECORDINGS_RETENTION_DAYS, 14, 0),
    maxRunsPerEndpoint: parseIntegerEnv(process.env.RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT, 100, 0),
    maxTotalBytes: parseIntegerEnv(process.env.RIVET_RECORDINGS_MAX_TOTAL_BYTES, 0, 0),
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
