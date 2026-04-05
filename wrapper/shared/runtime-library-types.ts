export interface RuntimeLibraryEntry {
  name: string;
  version: string;
  installedAt?: string;
}

export interface RuntimeLibraryPackageSpec {
  name: string;
  version: string;
}

export type JobStatus = 'queued' | 'running' | 'validating' | 'activating' | 'succeeded' | 'failed';
export type RuntimeLibraryLogSource = 'stdout' | 'stderr' | 'system';

export type RuntimeLibrariesBackendMode = 'filesystem' | 'managed';
export type RuntimeLibraryJobType = 'install' | 'remove';

export interface RuntimeLibraryJobLogEntry {
  message: string;
  createdAt: string;
  source: RuntimeLibraryLogSource;
}

export interface RuntimeLibraryJobState {
  id: string;
  type: RuntimeLibraryJobType;
  status: JobStatus;
  packages: RuntimeLibraryPackageSpec[];
  logs: string[];
  logEntries: RuntimeLibraryJobLogEntry[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  releaseId?: string | null;
  lastProgressAt: string;
  cancelRequestedAt?: string | null;
}

export interface RuntimeLibrariesState {
  backend: RuntimeLibrariesBackendMode;
  packages: Record<string, RuntimeLibraryEntry>;
  hasActiveLibraries: boolean;
  updatedAt: string;
  activeJob: RuntimeLibraryJobState | null;
  activeReleaseId?: string | null;
}
