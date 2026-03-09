import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';

import { validatePath } from '../../security.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, conflict } from '../../utils/httpError.js';
import {
  createBlankProjectFile,
  ensureWorkflowsRoot,
  getProjectSidecarPaths,
  pathExists,
  PROJECT_EXTENSION,
  resolveWorkflowRelativePath,
  sanitizeWorkflowName,
} from './fs-helpers.js';
import {
  createWorkflowPublicationStateHash,
  deletePublishedWorkflowSnapshot,
  ensureWorkflowEndpointNameIsUnique,
  normalizeWorkflowProjectSettingsDraft,
  readStoredWorkflowProjectSettings,
  writePublishedWorkflowSnapshot,
  writeStoredWorkflowProjectSettings,
} from './publication.js';
import { latestWorkflowsRouter, publishedWorkflowsRouter } from './execution.js';
import { getWorkflowFolder, getWorkflowProject, listWorkflowFolders, listWorkflowProjects, moveWorkflowFolder, moveWorkflowProject } from './tree.js';

export const workflowsRouter = Router();

const pathsDifferOnlyByCase = (leftPath: string, rightPath: string) =>
  leftPath !== rightPath && leftPath.toLowerCase() === rightPath.toLowerCase();

const renamePath = async (currentPath: string, nextPath: string) => {
  if (!pathsDifferOnlyByCase(currentPath, nextPath)) {
    await fs.rename(currentPath, nextPath);
    return;
  }

  const temporaryPath = validatePath(
    path.join(path.dirname(currentPath), `.${randomUUID()}-${path.basename(nextPath)}`),
  );

  await fs.rename(currentPath, temporaryPath);
  await fs.rename(temporaryPath, nextPath);
};

workflowsRouter.get('/tree', asyncHandler(async (_req, res) => {
  const root = await ensureWorkflowsRoot();
  const folders = await listWorkflowFolders(root);
  const projects = await listWorkflowProjects(root);
  res.json({ root, folders, projects });
}));

workflowsRouter.post('/move', asyncHandler(async (req, res) => {
  const { itemType, sourceRelativePath, destinationFolderRelativePath } = req.body ?? {};
  const root = await ensureWorkflowsRoot();

  if (itemType === 'project') {
    const result = await moveWorkflowProject(root, sourceRelativePath, destinationFolderRelativePath);
    res.json(result);
    return;
  }

  if (itemType === 'folder') {
    const result = await moveWorkflowFolder(root, sourceRelativePath, destinationFolderRelativePath);
    res.json(result);
    return;
  }

  throw badRequest('Invalid itemType');
}));

workflowsRouter.post('/folders', asyncHandler(async (req, res) => {
  const { name, parentRelativePath } = req.body ?? {};
  const folderName = sanitizeWorkflowName(name, 'folder name');
  const root = await ensureWorkflowsRoot();
  const parentFolderPath = resolveWorkflowRelativePath(root, parentRelativePath, {
    allowProjectFile: false,
    allowEmpty: true,
  });
  const folderPath = validatePath(path.join(parentFolderPath, folderName));

  try {
    await fs.access(folderPath);
    res.status(409).json({ error: `Folder already exists: ${folderName}` });
    return;
  } catch {
  }

  await fs.mkdir(folderPath, { recursive: false });
  res.status(201).json({ folder: await getWorkflowFolder(root, folderPath) });
}));

workflowsRouter.patch('/folders', asyncHandler(async (req, res) => {
  const { relativePath, newName } = req.body ?? {};
  const root = await ensureWorkflowsRoot();
  const currentFolderPath = resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: false,
  });
  const sanitizedName = sanitizeWorkflowName(newName, 'new folder name');
  const renamedFolderPath = validatePath(path.join(path.dirname(currentFolderPath), sanitizedName));

  if (renamedFolderPath !== currentFolderPath) {
    try {
      await fs.access(renamedFolderPath);
      res.status(409).json({ error: `Folder already exists: ${sanitizedName}` });
      return;
    } catch {
    }
  }

  await fs.rename(currentFolderPath, renamedFolderPath);
  res.json({ folder: await getWorkflowFolder(root, renamedFolderPath) });
}));

workflowsRouter.delete('/folders', asyncHandler(async (req, res) => {
  const { relativePath } = req.body ?? {};
  const root = await ensureWorkflowsRoot();
  const folderPath = resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: false,
  });

  const entries = await fs.readdir(folderPath);
  if (entries.length > 0) {
    throw conflict('Only empty folders can be deleted');
  }

  await fs.rmdir(folderPath);
  res.json({ deleted: true });
}));

workflowsRouter.post('/projects', asyncHandler(async (req, res) => {
  const { folderRelativePath, name } = req.body ?? {};
  const root = await ensureWorkflowsRoot();
  const folderPath = resolveWorkflowRelativePath(root, folderRelativePath, {
    allowProjectFile: false,
    allowEmpty: true,
  });
  const projectName = sanitizeWorkflowName(name, 'project name');
  const fileName = `${projectName}${PROJECT_EXTENSION}`;
  const filePath = validatePath(path.join(folderPath, fileName));

  try {
    await fs.access(filePath);
    res.status(409).json({ error: `Project already exists: ${fileName}` });
    return;
  } catch {
  }

  await fs.writeFile(filePath, createBlankProjectFile(projectName), 'utf8');

  res.status(201).json({
    project: await getWorkflowProject(root, filePath),
  });
}));

workflowsRouter.patch('/projects', asyncHandler(async (req, res) => {
  const { relativePath, newName } = req.body ?? {};
  const root = await ensureWorkflowsRoot();
  const currentProjectPath = resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  });

  if (!currentProjectPath.endsWith(PROJECT_EXTENSION)) {
    throw badRequest('Expected project path');
  }

  const projectName = sanitizeWorkflowName(newName, 'new project name');
  const renamedProjectPath = validatePath(path.join(path.dirname(currentProjectPath), `${projectName}${PROJECT_EXTENSION}`));
  const isCaseOnlyRename = pathsDifferOnlyByCase(currentProjectPath, renamedProjectPath);

  if (renamedProjectPath !== currentProjectPath && !isCaseOnlyRename) {
    try {
      await fs.access(renamedProjectPath);
      res.status(409).json({ error: `Project already exists: ${path.basename(renamedProjectPath)}` });
      return;
    } catch {
    }
  }

  await renamePath(currentProjectPath, renamedProjectPath);

  const currentSidecars = getProjectSidecarPaths(currentProjectPath);
  const renamedSidecars = getProjectSidecarPaths(renamedProjectPath);
  if (await pathExists(currentSidecars.dataset)) {
    await renamePath(currentSidecars.dataset, renamedSidecars.dataset);
  }

  if (await pathExists(currentSidecars.settings)) {
    await renamePath(currentSidecars.settings, renamedSidecars.settings);
  }

  res.json({
    project: await getWorkflowProject(root, renamedProjectPath),
    movedProjectPaths: [
      {
        fromAbsolutePath: currentProjectPath,
        toAbsolutePath: renamedProjectPath,
      },
    ],
  });
}));

workflowsRouter.post('/projects/publish', asyncHandler(async (req, res) => {
  const { relativePath, settings } = req.body ?? {};
  const root = await ensureWorkflowsRoot();
  const projectPath = resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  });

  if (!projectPath.endsWith(PROJECT_EXTENSION)) {
    throw badRequest('Expected project path');
  }

  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const existingSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  const normalizedSettings = normalizeWorkflowProjectSettingsDraft(settings);
  await ensureWorkflowEndpointNameIsUnique(root, projectPath, normalizedSettings.endpointName);
  const publishedStateHash = await createWorkflowPublicationStateHash(projectPath, normalizedSettings.endpointName);
  const publishedSnapshotId = existingSettings.publishedSnapshotId ?? randomUUID();
  await writePublishedWorkflowSnapshot(root, projectPath, publishedSnapshotId);
  await writeStoredWorkflowProjectSettings(projectPath, {
    endpointName: normalizedSettings.endpointName,
    publishedEndpointName: normalizedSettings.endpointName,
    publishedSnapshotId,
    publishedStateHash,
  });

  res.json({
    project: await getWorkflowProject(root, projectPath),
  });
}));

workflowsRouter.post('/projects/unpublish', asyncHandler(async (req, res) => {
  const { relativePath } = req.body ?? {};
  const root = await ensureWorkflowsRoot();
  const projectPath = resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  });

  if (!projectPath.endsWith(PROJECT_EXTENSION)) {
    throw badRequest('Expected project path');
  }

  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const existingSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  await deletePublishedWorkflowSnapshot(root, existingSettings.publishedSnapshotId);
  await writeStoredWorkflowProjectSettings(projectPath, {
    endpointName: existingSettings.endpointName,
    publishedEndpointName: '',
    publishedSnapshotId: null,
    publishedStateHash: null,
  });

  res.json({
    project: await getWorkflowProject(root, projectPath),
  });
}));

workflowsRouter.delete('/projects', asyncHandler(async (req, res) => {
  const { relativePath } = req.body ?? {};
  const root = await ensureWorkflowsRoot();
  const projectPath = resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  });

  if (!projectPath.endsWith(PROJECT_EXTENSION)) {
    throw badRequest('Expected project path');
  }

  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const existingSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  await deletePublishedWorkflowSnapshot(root, existingSettings.publishedSnapshotId);
  await fs.rm(projectPath, { force: false });

  const sidecars = getProjectSidecarPaths(projectPath);
  if (await pathExists(sidecars.dataset)) {
    await fs.rm(sidecars.dataset, { force: false });
  }

  if (await pathExists(sidecars.settings)) {
    await fs.rm(sidecars.settings, { force: false });
  }

  res.json({ deleted: true });
}));

export { latestWorkflowsRouter, publishedWorkflowsRouter };
export type {
  LatestWorkflowMatch,
  PublishedWorkflowMatch,
  StoredWorkflowProjectSettings,
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
} from './types.js';
