import { RIVET_API_BASE_URL } from '../../shared/hosted-env';
import type { RuntimeLibraryEntry, JobStatus } from '../../shared/runtime-library-types';

export type { RuntimeLibraryEntry, JobStatus };

const API = `${RIVET_API_BASE_URL}/runtime-libraries`;

export interface RuntimeLibrariesState {
  packages: Record<string, RuntimeLibraryEntry>;
  hasActiveLibraries: boolean;
  updatedAt: string;
  activeJob: JobState | null;
}

export interface JobState {
  id: string;
  type: 'install' | 'remove';
  status: JobStatus;
  packages: Array<{ name: string; version: string }>;
  logs: string[];
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface SSEEvent {
  type: 'log' | 'status' | 'done';
  message?: string;
  status?: JobStatus;
  error?: string;
}

async function jsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(data.error || response.statusText);
  }
  return response.json() as Promise<T>;
}

export async function fetchRuntimeLibraries(): Promise<RuntimeLibrariesState> {
  const response = await fetch(API);
  return jsonResponse<RuntimeLibrariesState>(response);
}

export async function installPackages(
  packages: Array<{ name: string; version: string }>,
): Promise<JobState> {
  const response = await fetch(`${API}/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packages }),
  });
  return jsonResponse<JobState>(response);
}

export async function removePackages(packages: string[]): Promise<JobState> {
  const response = await fetch(`${API}/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packages }),
  });
  return jsonResponse<JobState>(response);
}

export async function fetchJob(jobId: string): Promise<JobState> {
  const response = await fetch(`${API}/jobs/${jobId}`);
  return jsonResponse<JobState>(response);
}

export function streamJobLogs(
  jobId: string,
  onEvent: (event: SSEEvent) => void,
  onError?: (err: Event) => void,
): EventSource {
  const source = new EventSource(`${API}/jobs/${jobId}/stream`);

  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as SSEEvent;
      onEvent(data);

      if (data.type === 'done') {
        source.close();
      }
    } catch {
      // ignore parse errors
    }
  };

  source.onerror = (err) => {
    onError?.(err);
    source.close();
  };

  return source;
}
