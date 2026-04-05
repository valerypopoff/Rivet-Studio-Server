import { RIVET_API_BASE_URL } from '../../shared/hosted-env';
import type {
  JobStatus,
  RuntimeLibrariesState,
  RuntimeLibraryEntry,
  RuntimeLibraryLogSource,
  RuntimeLibraryJobState,
} from '../../shared/runtime-library-types';

export type {
  RuntimeLibrariesState,
  RuntimeLibraryEntry,
  RuntimeLibraryJobState,
  JobStatus,
  RuntimeLibraryLogSource,
} from '../../shared/runtime-library-types';

const API = `${RIVET_API_BASE_URL}/runtime-libraries`;

export type JobState = RuntimeLibraryJobState;

export interface SSEEvent {
  type: 'log' | 'status' | 'done';
  message?: string;
  status?: JobStatus;
  error?: string;
  createdAt?: string;
  source?: RuntimeLibraryLogSource;
  cancelRequestedAt?: string | null;
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

export async function cancelJob(jobId: string): Promise<JobState> {
  const response = await fetch(`${API}/jobs/${jobId}/cancel`, {
    method: 'POST',
  });
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
