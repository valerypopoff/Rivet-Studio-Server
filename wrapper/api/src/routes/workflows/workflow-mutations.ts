import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  loadProjectAndAttachedDataFromFile,
  loadProjectFromFile,
  serializeProject,
} from '@ironclad/rivet-node';

import { validatePath } from '../../security.js';
import { conflict, createHttpError } from '../../utils/httpError.js';
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
import { deleteWorkflowRecordingsBySourceProjectPath, deleteWorkflowRecordingsByWorkflowId } from './recordings.js';
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

function getDuplicateWorkflowProjectName(sourceProjectName: string, duplicateIndex: number): string {
  return duplicateIndex === 0
    ? `${sourceProjectName} Copy`
    : `${sourceProjectName} Copy ${duplicateIndex}`;
}

function getDuplicateWorkflowProjectPath(sourceProjectPath: string, duplicateIndex: number): {
  duplicateProjectName: string;
  duplicateProjectPath: string;
} {
  const sourceProjectName = path.basename(sourceProjectPath, PROJECT_EXTENSION);
  const sourceFolderPath = path.dirname(sourceProjectPath);
  const duplicateProjectName = getDuplicateWorkflowProjectName(sourceProjectName, duplicateIndex);
  const duplicateProjectPath = validatePath(path.join(sourceFolderPath, `${duplicateProjectName}${PROJECT_EXTENSION}`));

  return {
    duplicateProjectName,
    duplicateProjectPath,
  };
}

export async function duplicateWorkflowProjectItem(relativePath: unknown) {
  const root = await ensureWorkflowsRoot();
  const sourceProjectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  if (!await pathExists(sourceProjectPath)) {
    throw createHttpError(404, 'Project not found');
  }

  let project: Awaited<ReturnType<typeof loadProjectAndAttachedDataFromFile>>[0];
  let attachedData: Awaited<ReturnType<typeof loadProjectAndAttachedDataFromFile>>[1];

  try {
    [project, attachedData] = await loadProjectAndAttachedDataFromFile(sourceProjectPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw createHttpError(404, 'Project not found');
    }

    throw createHttpError(400, 'Could not duplicate project: invalid project file');
  }

  const duplicateProjectId = randomUUID() as typeof project.metadata.id;

  for (let duplicateIndex = 0; ; duplicateIndex += 1) {
    const { duplicateProjectName, duplicateProjectPath } = getDuplicateWorkflowProjectPath(sourceProjectPath, duplicateIndex);
    let serializedProject: string;

    try {
      project.metadata.id = duplicateProjectId;
      project.metadata.title = duplicateProjectName;

      const nextSerializedProject = serializeProject(project, attachedData);
      if (typeof nextSerializedProject !== 'string') {
        throw new Error('Project serialization did not return a string');
      }

      serializedProject = nextSerializedProject;
    } catch (error) {
      throw createHttpError(400, 'Could not duplicate project: invalid project file');
    }

    try {
      await fs.writeFile(duplicateProjectPath, serializedProject, { encoding: 'utf8', flag: 'wx' });
      return getWorkflowProject(root, duplicateProjectPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }

      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw createHttpError(404, 'Project not found');
      }

      throw error;
    }
  }
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
  const projectMetadataId = await loadProjectFromFile(projectPath)
    .then((project) => project.metadata.id ?? null)
    .catch(() => null);
  await deletePublishedWorkflowSnapshot(root, existingSettings.publishedSnapshotId);
  await deleteProjectWithSidecars(projectPath);
  await deleteWorkflowRecordingsByWorkflowId(root, projectMetadataId);
  await deleteWorkflowRecordingsBySourceProjectPath(root, projectPath);
}
