import { RIVET_API_BASE_URL } from '../../shared/hosted-env';
import type {
  WorkflowFolderItem,
  WorkflowMoveResponse,
  WorkflowProjectItem,
  WorkflowProjectSettingsDraft,
  WorkflowRecordingFilterStatus,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingWorkflowListResponse,
  WorkflowTreeResponse,
} from './types';

const API = RIVET_API_BASE_URL;

type ResponseError = Error & {
  status?: number;
};

function createResponseError(status: number, message: string): ResponseError {
  const error = new Error(message) as ResponseError;
  error.status = status;
  return error;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('application/json')) {
    const text = await response.text();

    if (text.trim().startsWith('<!doctype') || text.trim().startsWith('<html')) {
      throw new Error(
        'Workflow API returned HTML instead of JSON. Make sure you are accessing the app through the proxy and that /api/workflows is routed to the API service.',
      );
    }

    throw new Error(`Workflow API returned an unexpected response type (${contentType || 'unknown'}).`);
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: response.statusText }));
    throw createResponseError(response.status, data.error || response.statusText);
  }

  return response.json() as Promise<T>;
}

async function parseTextResponse(response: Response): Promise<string> {
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const data = await response.json().catch(() => ({ error: response.statusText }));
      throw createResponseError(response.status, data.error || response.statusText);
    }

    throw createResponseError(response.status, response.statusText);
  }

  return response.text();
}

export async function fetchWorkflowTree(): Promise<WorkflowTreeResponse> {
  const response = await fetch(`${API}/workflows/tree`, {
    cache: 'no-store',
  });
  return parseJsonResponse<WorkflowTreeResponse>(response);
}

export async function fetchWorkflowRecordingWorkflows(): Promise<WorkflowRecordingWorkflowListResponse> {
  const response = await fetch(`${API}/workflows/recordings/workflows`, {
    cache: 'no-store',
  });
  return parseJsonResponse<WorkflowRecordingWorkflowListResponse>(response);
}

export async function fetchWorkflowRecordingRuns(
  workflowId: string,
  options: {
    page: number;
    pageSize: number;
    status: WorkflowRecordingFilterStatus;
  },
): Promise<WorkflowRecordingRunsPageResponse> {
  const query = new URLSearchParams({
    page: String(options.page),
    pageSize: String(options.pageSize),
    status: options.status,
  });
  const response = await fetch(`${API}/workflows/recordings/workflows/${encodeURIComponent(workflowId)}/runs?${query}`, {
    cache: 'no-store',
  });
  return parseJsonResponse<WorkflowRecordingRunsPageResponse>(response);
}

export async function fetchWorkflowRecordingArtifactText(
  recordingId: string,
  artifact: 'recording' | 'replay-project' | 'replay-dataset',
): Promise<string> {
  const response = await fetch(`${API}/workflows/recordings/${encodeURIComponent(recordingId)}/${artifact}`, {
    cache: 'no-store',
  });
  return parseTextResponse(response);
}

export async function deleteWorkflowRecording(recordingId: string): Promise<void> {
  const response = await fetch(`${API}/workflows/recordings/${encodeURIComponent(recordingId)}`, {
    method: 'DELETE',
  });
  await parseJsonResponse<{ deleted: true }>(response);
}

export async function createWorkflowFolder(name: string): Promise<WorkflowFolderItem> {
  const response = await fetch(`${API}/workflows/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  const data = await parseJsonResponse<{ folder: WorkflowFolderItem }>(response);
  return data.folder;
}

export async function renameWorkflowFolder(relativePath: string, newName: string): Promise<WorkflowFolderItem> {
  const response = await fetch(`${API}/workflows/folders`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, newName }),
  });

  const data = await parseJsonResponse<{ folder: WorkflowFolderItem }>(response);
  return data.folder;
}

export async function deleteWorkflowFolder(relativePath: string): Promise<void> {
  const response = await fetch(`${API}/workflows/folders`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath }),
  });

  await parseJsonResponse<{ deleted: true }>(response);
}

export async function createWorkflowProject(
  folderRelativePath: string,
  name: string,
): Promise<WorkflowProjectItem> {
  const response = await fetch(`${API}/workflows/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderRelativePath, name }),
  });

  const data = await parseJsonResponse<{ project: WorkflowProjectItem }>(response);
  return data.project;
}

export async function renameWorkflowProject(
  relativePath: string,
  newName: string,
): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowMoveResponse['movedProjectPaths'] }> {
  const response = await fetch(`${API}/workflows/projects`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, newName }),
  });

  return parseJsonResponse<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowMoveResponse['movedProjectPaths'] }>(response);
}

export async function moveWorkflowItem(
  itemType: 'folder' | 'project',
  sourceRelativePath: string,
  destinationFolderRelativePath: string,
): Promise<WorkflowMoveResponse> {
  const response = await fetch(`${API}/workflows/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      itemType,
      sourceRelativePath,
      destinationFolderRelativePath,
    }),
  });

  return parseJsonResponse<WorkflowMoveResponse>(response);
}

export async function publishWorkflowProject(
  relativePath: string,
  settings: WorkflowProjectSettingsDraft,
): Promise<WorkflowProjectItem> {
  const response = await fetch(`${API}/workflows/projects/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, settings }),
  });

  const data = await parseJsonResponse<{ project: WorkflowProjectItem }>(response);
  return data.project;
}

export async function unpublishWorkflowProject(relativePath: string): Promise<WorkflowProjectItem> {
  const response = await fetch(`${API}/workflows/projects/unpublish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath }),
  });

  const data = await parseJsonResponse<{ project: WorkflowProjectItem }>(response);
  return data.project;
}

export async function deleteWorkflowProject(relativePath: string): Promise<void> {
  const response = await fetch(`${API}/workflows/projects`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath }),
  });

  await parseJsonResponse<{ deleted: true }>(response);
}
