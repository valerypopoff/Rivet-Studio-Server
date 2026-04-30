import type { Project } from '@ironclad/rivet-core';

const PROJECT_FILE_EXTENSION = /\.rivet-project$/i;

function normalizeTitleCandidate(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (lower === 'undefined' || lower === 'null') {
    return null;
  }

  return trimmed;
}

function getFileName(path: string | null | undefined): string | null {
  const trimmedPath = path?.trim();
  if (!trimmedPath) {
    return null;
  }

  const fileName = trimmedPath.split(/[\\/]/).filter(Boolean).pop()?.trim();
  if (!fileName) {
    return null;
  }

  const withoutExtension = fileName.replace(PROJECT_FILE_EXTENSION, '').trim();
  return withoutExtension || fileName;
}

export function resolveHostedProjectTitle(
  project: Pick<Project, 'metadata'> | null | undefined,
  fsPath?: string | null,
): string {
  const title = normalizeTitleCandidate(project?.metadata?.title);
  if (title) {
    return title;
  }

  return getFileName(fsPath) ?? 'Untitled Project';
}

export function withHostedProjectTitle<T extends Pick<Project, 'metadata'>>(
  project: T,
  fsPath?: string | null,
): T {
  const title = resolveHostedProjectTitle(project, fsPath);

  if (project.metadata.title === title) {
    return project;
  }

  return {
    ...project,
    metadata: {
      ...project.metadata,
      title,
    },
  };
}
