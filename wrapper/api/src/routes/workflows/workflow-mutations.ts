import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { validatePath } from '../../security.js';
import { conflict } from '../../utils/httpError.js';
import {
  createBlankProjectFile,
  deleteProjectWithSidecars,
  ensureWorkflowsRoot,
  moveProjectWithSidecars,
  pathExists,
  pathsDifferOnlyByCase,
  PROJECT_EXTENSION,
  renamePathHandlingCaseChange,
  requireProjectPath,
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
import { getWorkflowFolder, getWorkflowProject } from './workflow-query.js';

export async function createWorkflowFolderItem(name: unknown, parentRelativePath: unknown) {
  const folderName = sanitizeWorkflowName(name, 'folder name');
  const root = await ensureWorkflowsRoot();
  const parentFolderPath = resolveWorkflowRelativePath(root, parentRelativePath, {
    allowProjectFile: false,
    allowEmpty: true,
  });
  const folderPath = validatePath(path.join(parentFolderPath, folderName));

  if (await pathExists(folderPath)) {
    throw conflict(`Folder already exists: ${folderName}`);
  }

  await fs.mkdir(folderPath, { recursive: false });
  return getWorkflowFolder(root, folderPath);
}

export async function renameWorkflowFolderItem(relativePath: unknown, newName: unknown) {
  const root = await ensureWorkflowsRoot();
  const currentFolderPath = resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: false,
  });
  const sanitizedName = sanitizeWorkflowName(newName, 'new folder name');
  const renamedFolderPath = validatePath(path.join(path.dirname(currentFolderPath), sanitizedName));
  const isCaseOnlyRename = pathsDifferOnlyByCase(currentFolderPath, renamedFolderPath);

  if (renamedFolderPath !== currentFolderPath && !isCaseOnlyRename && await pathExists(renamedFolderPath)) {
    throw conflict(`Folder already exists: ${sanitizedName}`);
  }

  await renamePathHandlingCaseChange(currentFolderPath, renamedFolderPath);
  return getWorkflowFolder(root, renamedFolderPath);
}

export async function deleteWorkflowFolderItem(relativePath: unknown) {
  const root = await ensureWorkflowsRoot();
  const folderPath = resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: false,
  });

  const entries = await fs.readdir(folderPath);
  if (entries.length > 0) {
    throw conflict('Only empty folders can be deleted');
  }

  await fs.rmdir(folderPath);
}

export async function createWorkflowProjectItem(folderRelativePath: unknown, name: unknown) {
  const root = await ensureWorkflowsRoot();
  const folderPath = resolveWorkflowRelativePath(root, folderRelativePath, {
    allowProjectFile: false,
    allowEmpty: true,
  });
  const projectName = sanitizeWorkflowName(name, 'project name');
  const fileName = `${projectName}${PROJECT_EXTENSION}`;
  const filePath = validatePath(path.join(folderPath, fileName));

  if (await pathExists(filePath)) {
    throw conflict(`Project already exists: ${fileName}`);
  }

  await fs.writeFile(filePath, createBlankProjectFile(projectName), 'utf8');
  return getWorkflowProject(root, filePath);
}

export async function renameWorkflowProjectItem(relativePath: unknown, newName: unknown) {
  const root = await ensureWorkflowsRoot();
  const currentProjectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  const projectName = sanitizeWorkflowName(newName, 'new project name');
  const renamedProjectPath = validatePath(path.join(path.dirname(currentProjectPath), `${projectName}${PROJECT_EXTENSION}`));
  const isCaseOnlyRename = pathsDifferOnlyByCase(currentProjectPath, renamedProjectPath);

  if (renamedProjectPath !== currentProjectPath && !isCaseOnlyRename && await pathExists(renamedProjectPath)) {
    throw conflict(`Project already exists: ${path.basename(renamedProjectPath)}`);
  }

  await moveProjectWithSidecars(currentProjectPath, renamedProjectPath);

  return {
    project: await getWorkflowProject(root, renamedProjectPath),
    movedProjectPaths: [
      {
        fromAbsolutePath: currentProjectPath,
        toAbsolutePath: renamedProjectPath,
      },
    ],
  };
}

export async function publishWorkflowProjectItem(relativePath: unknown, settings: unknown) {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));
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

  return getWorkflowProject(root, projectPath);
}

export async function unpublishWorkflowProjectItem(relativePath: unknown) {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const existingSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  await deletePublishedWorkflowSnapshot(root, existingSettings.publishedSnapshotId);
  await writeStoredWorkflowProjectSettings(projectPath, {
    endpointName: existingSettings.endpointName,
    publishedEndpointName: '',
    publishedSnapshotId: null,
    publishedStateHash: null,
  });

  return getWorkflowProject(root, projectPath);
}

export async function deleteWorkflowProjectItem(relativePath: unknown) {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const existingSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  await deletePublishedWorkflowSnapshot(root, existingSettings.publishedSnapshotId);
  await deleteProjectWithSidecars(projectPath);
}
