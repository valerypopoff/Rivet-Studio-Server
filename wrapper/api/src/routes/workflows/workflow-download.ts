import fs from 'node:fs/promises';
import path from 'node:path';

import type { WorkflowProjectDownloadVersion, WorkflowProjectStatus } from '../../../../shared/workflow-types.js';
import { createHttpError, conflict } from '../../utils/httpError.js';
import {
  ensureWorkflowsRoot,
  pathExists,
  PROJECT_EXTENSION,
  requireProjectPath,
  resolveWorkflowRelativePath,
} from './fs-helpers.js';
import { getWorkflowProjectSettings, readStoredWorkflowProjectSettings, resolvePublishedWorkflowProjectPath } from './publication.js';

type WorkflowProjectDownloadResult = {
  contents: string;
  fileName: string;
};

function getWorkflowProjectDownloadTag(
  version: WorkflowProjectDownloadVersion,
  status: WorkflowProjectStatus,
): string {
  if (version === 'published') {
    return 'published';
  }

  switch (status) {
    case 'published':
      return 'published';
    case 'unpublished_changes':
      return 'unpublished changes';
    case 'unpublished':
    default:
      return 'unpublished';
  }
}

function getAsciiContentDispositionFileName(fileName: string): string {
  return fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '_');
}

export function createWorkflowDownloadContentDisposition(fileName: string): string {
  const asciiFileName = getAsciiContentDispositionFileName(fileName);
  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function readWorkflowProjectDownload(
  relativePath: unknown,
  version: WorkflowProjectDownloadVersion,
): Promise<WorkflowProjectDownloadResult> {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  if (!await pathExists(projectPath)) {
    throw createHttpError(404, 'Project not found');
  }

  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const settings = await getWorkflowProjectSettings(projectPath, projectName);
  const downloadTag = getWorkflowProjectDownloadTag(version, settings.status);

  let sourcePath = projectPath;
  if (version === 'published') {
    const storedSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
    const publishedProjectPath = await resolvePublishedWorkflowProjectPath(root, projectPath, storedSettings);
    if (!publishedProjectPath) {
      throw conflict('Published version is not available for this project');
    }
    sourcePath = publishedProjectPath;
  }

  try {
    return {
      contents: await fs.readFile(sourcePath, 'utf8'),
      fileName: `${projectName} [${downloadTag}]${PROJECT_EXTENSION}`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw createHttpError(404, 'Project not found');
    }

    throw error;
  }
}
