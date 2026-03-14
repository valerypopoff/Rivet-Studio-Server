export interface RuntimeLibraryEntry {
  name: string;
  version: string;
  installedAt?: string;
}

export type JobStatus = 'queued' | 'running' | 'validating' | 'activating' | 'succeeded' | 'failed';
