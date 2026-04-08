import type { WorkflowProjectStatus } from './types';

export const PROJECT_FILE_EXTENSION = '.rivet-project';
export const ENDPOINT_NAME_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

const WORKFLOW_PROJECT_STATUS_LABELS: Record<WorkflowProjectStatus, string> = {
  unpublished: 'Unpublished',
  published: 'Published',
  unpublished_changes: 'Unpublished changes',
};

export function getWorkflowProjectStatusLabel(status: WorkflowProjectStatus): string {
  return WORKFLOW_PROJECT_STATUS_LABELS[status];
}

export function normalizeProjectNameDraft(projectNameDraft: string): string {
  const trimmed = projectNameDraft.trim();
  return trimmed.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)
    ? trimmed.slice(0, -PROJECT_FILE_EXTENSION.length).trim()
    : trimmed;
}

export function validateProjectName(
  normalizedProjectNameDraft: string,
  duplicateProjectFileName: string | null,
  options: {
    enabled?: boolean;
  } = {},
): string | null {
  if (options.enabled === false) {
    return null;
  }

  if (!normalizedProjectNameDraft) {
    return 'Project name is required.';
  }

  if (/[\\/]/.test(normalizedProjectNameDraft)) {
    return 'Project name must not contain path separators.';
  }

  if (/[<>:"|?*]/.test(normalizedProjectNameDraft)) {
    return 'Project name contains invalid filesystem characters.';
  }

  if (duplicateProjectFileName) {
    return `A project named ${duplicateProjectFileName} already exists in this folder.`;
  }

  return null;
}

export function validateEndpointName(
  endpointName: string,
  duplicateProjectFileName: string | null,
): string | null {
  const trimmedEndpointName = endpointName.trim();
  if (!trimmedEndpointName) {
    return 'Endpoint name is required to publish.';
  }

  if (!ENDPOINT_NAME_PATTERN.test(trimmedEndpointName)) {
    return 'Endpoint name must contain only letters, numbers, and hyphens.';
  }

  if (duplicateProjectFileName) {
    return `Endpoint name is already used by ${duplicateProjectFileName}.`;
  }

  return null;
}

export function formatLastPublishedAtLabel(
  status: WorkflowProjectStatus,
  lastPublishedAt: string | null | undefined,
): string | null {
  if (status === 'unpublished' || !lastPublishedAt) {
    return null;
  }

  const publishedAtDate = new Date(lastPublishedAt);
  if (Number.isNaN(publishedAtDate.getTime())) {
    return null;
  }

  return `Last published on ${new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(publishedAtDate)}`;
}
