import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadProjectFromFile, NodeDatasetProvider, runGraph } from '@ironclad/rivet-node';
import { getWorkflowsRoot, validatePath } from '../security.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { badRequest, conflict } from '../utils/httpError.js';

export const workflowsRouter = Router();
export const publishedWorkflowsRouter = Router();

const PROJECT_EXTENSION = '.rivet-project';
const PROJECT_SETTINGS_SUFFIX = '.wrapper-settings.json';
const PUBLISHED_SNAPSHOTS_DIR = '.published';

type WorkflowProjectStatus = 'unpublished' | 'published' | 'unpublished_changes';

type WorkflowProjectSettings = {
  status: WorkflowProjectStatus;
  endpointName: string;
};

type WorkflowProjectSettingsDraft = {
  endpointName: string;
};

type StoredWorkflowProjectSettings = {
  endpointName: string;
  publishedEndpointName: string;
  publishedSnapshotId: string | null;
  publishedStateHash: string | null;
  legacyStatus?: WorkflowProjectStatus;
};

type WorkflowProjectPathMove = {
  fromAbsolutePath: string;
  toAbsolutePath: string;
};

type WorkflowProjectItem = {
  id: string;
  name: string;
  fileName: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
  settings: WorkflowProjectSettings;
};

type WorkflowFolderItem = {
  id: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
  folders: WorkflowFolderItem[];
  projects: WorkflowProjectItem[];
};

type PublishedWorkflowMatch = {
  endpointName: string;
  projectPath: string;
  publishedProjectPath: string;
};

workflowsRouter.get('/tree', asyncHandler(async (_req, res) => {
  const root = await ensureWorkflowsRoot();
  const folders = await listWorkflowFolders(root);
  const projects = await listWorkflowProjects(root);
  res.json({ root, folders, projects });
}));

publishedWorkflowsRouter.post('/:endpointName', asyncHandler(async (req, res) => {
  const root = await ensureWorkflowsRoot();
  const endpointName = normalizeStoredEndpointName(String(req.params.endpointName ?? ''));
  if (!endpointName) {
    throw badRequest('Endpoint name is required');
  }

  const publishedWorkflow = await findPublishedWorkflowByEndpoint(root, endpointName);
  if (!publishedWorkflow) {
    res.status(404).json({ error: 'Published workflow not found' });
    return;
  }

  try {
    const project = await loadProjectFromFile(publishedWorkflow.publishedProjectPath);
    const datasetProvider = await NodeDatasetProvider.fromProjectFile(publishedWorkflow.publishedProjectPath);
    const projectReferenceLoader = createPublishedWorkflowProjectReferenceLoader(root, publishedWorkflow.projectPath);
    const outputs = await runGraph(project, {
      projectPath: publishedWorkflow.projectPath,
      datasetProvider,
      projectReferenceLoader,
      inputs: {
        input: {
          type: 'any',
          value: {
            payload: req.body ?? {},
          },
        },
      },
    });

    const outputValue = outputs.output;
    if (outputValue?.type === 'any' && outputValue.value != null && typeof outputValue.value === 'object') {
      res.status(200).json(outputValue.value);
      return;
    }

    res.status(200).json(outputs);
  } catch (error) {
    const errorPayload = error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : {
          message: String(error),
        };

    res.status(500).json({ error: errorPayload });
  }
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
    // expected
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
      // expected
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
    // expected
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

  if (renamedProjectPath !== currentProjectPath) {
    try {
      await fs.access(renamedProjectPath);
      res.status(409).json({ error: `Project already exists: ${path.basename(renamedProjectPath)}` });
      return;
    } catch {
      // expected
    }
  }

  await fs.rename(currentProjectPath, renamedProjectPath);

  const currentDatasetPath = currentProjectPath.replace(PROJECT_EXTENSION, '.rivet-data');
  const renamedDatasetPath = renamedProjectPath.replace(PROJECT_EXTENSION, '.rivet-data');
  if (await pathExists(currentDatasetPath)) {
    await fs.rename(currentDatasetPath, renamedDatasetPath);
  }

  const currentSettingsPath = getWorkflowProjectSettingsPath(currentProjectPath);
  const renamedSettingsPath = getWorkflowProjectSettingsPath(renamedProjectPath);
  if (await pathExists(currentSettingsPath)) {
    await fs.rename(currentSettingsPath, renamedSettingsPath);
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

workflowsRouter.patch('/projects/settings', asyncHandler(async (req, res) => {
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
  await writeStoredWorkflowProjectSettings(projectPath, {
    ...existingSettings,
    endpointName: normalizedSettings.endpointName,
  });

  res.json({
    project: await getWorkflowProject(root, projectPath),
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

  const datasetPath = projectPath.replace(PROJECT_EXTENSION, '.rivet-data');
  if (await pathExists(datasetPath)) {
    await fs.rm(datasetPath, { force: false });
  }

  const settingsPath = getWorkflowProjectSettingsPath(projectPath);
  if (await pathExists(settingsPath)) {
    await fs.rm(settingsPath, { force: false });
  }

  res.json({ deleted: true });
}));

async function ensureWorkflowsRoot(): Promise<string> {
  const root = getWorkflowsRoot();
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(getPublishedSnapshotsRoot(root), { recursive: true });
  return root;
}

function sanitizeWorkflowName(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw badRequest(`Missing ${label}`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw badRequest(`Missing ${label}`);
  }

  if (trimmed === '.' || trimmed === '..') {
    throw badRequest(`Invalid ${label}`);
  }

  if (/[\\/]/.test(trimmed)) {
    throw badRequest(`${label} must not contain path separators`);
  }

  if (/[<>:"|?*]/.test(trimmed)) {
    throw badRequest(`${label} contains invalid filesystem characters`);
  }

  return trimmed;
}

function resolveWorkflowRelativePath(
  root: string,
  relativePath: unknown,
  options: {
    allowProjectFile: boolean;
    allowEmpty?: boolean;
  },
): string {
  if (typeof relativePath !== 'string') {
    if (options.allowEmpty && (relativePath == null || relativePath === '')) {
      return root;
    }

    throw badRequest('Missing relativePath');
  }

  const normalized = relativePath.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');

  if (!normalized) {
    if (options.allowEmpty) {
      return root;
    }

    throw badRequest('Missing relativePath');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw badRequest('Invalid relativePath');
  }

  if (!options.allowProjectFile && normalized.endsWith(PROJECT_EXTENSION)) {
    throw badRequest('Expected folder path, received project path');
  }

  return validatePath(path.join(root, ...segments));
}

async function listWorkflowFolders(root: string): Promise<WorkflowFolderItem[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const folders = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => getWorkflowFolder(root, path.join(root, entry.name))),
  );

  return folders;
}

async function listWorkflowProjects(root: string): Promise<WorkflowProjectItem[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(PROJECT_EXTENSION))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => getWorkflowProject(root, path.join(root, entry.name))),
  );

  return projects;
}

async function getWorkflowFolder(root: string, folderPath: string): Promise<WorkflowFolderItem> {
  const stats = await fs.stat(folderPath);
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const folders = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => getWorkflowFolder(root, path.join(folderPath, entry.name))),
  );
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(PROJECT_EXTENSION))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => getWorkflowProject(root, path.join(folderPath, entry.name))),
  );

  return {
    id: path.relative(root, folderPath).replace(/\\/g, '/'),
    name: path.basename(folderPath),
    relativePath: path.relative(root, folderPath).replace(/\\/g, '/'),
    absolutePath: folderPath,
    updatedAt: stats.mtime.toISOString(),
    folders,
    projects,
  };
}

async function getWorkflowProject(root: string, filePath: string): Promise<WorkflowProjectItem> {
  const stats = await fs.stat(filePath);
  const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
  const fileName = path.basename(filePath);
  const projectName = fileName.slice(0, -PROJECT_EXTENSION.length);

  return {
    id: relativePath,
    name: projectName,
    fileName,
    relativePath,
    absolutePath: filePath,
    updatedAt: stats.mtime.toISOString(),
    settings: await getWorkflowProjectSettings(filePath, projectName),
  };
}

async function moveWorkflowProject(
  root: string,
  sourceRelativePath: unknown,
  destinationFolderRelativePath: unknown,
): Promise<{ project: Awaited<ReturnType<typeof getWorkflowProject>>; movedProjectPaths: WorkflowProjectPathMove[] }> {
  const sourceProjectPath = resolveWorkflowRelativePath(root, sourceRelativePath, {
    allowProjectFile: true,
  });
  const destinationFolderPath = resolveWorkflowRelativePath(root, destinationFolderRelativePath, {
    allowProjectFile: false,
    allowEmpty: true,
  });

  if (!sourceProjectPath.endsWith(PROJECT_EXTENSION)) {
    throw badRequest('Expected project path');
  }

  const targetProjectPath = validatePath(path.join(destinationFolderPath, path.basename(sourceProjectPath)));
  if (targetProjectPath === sourceProjectPath) {
    return {
      project: await getWorkflowProject(root, sourceProjectPath),
      movedProjectPaths: [],
    };
  }

  await ensurePathDoesNotExist(targetProjectPath, `Project already exists: ${path.basename(targetProjectPath)}`);

  const sourceDatasetPath = sourceProjectPath.replace(PROJECT_EXTENSION, '.rivet-data');
  const targetDatasetPath = targetProjectPath.replace(PROJECT_EXTENSION, '.rivet-data');
  const sourceDatasetExists = await pathExists(sourceDatasetPath);
  if (sourceDatasetExists) {
    await ensurePathDoesNotExist(targetDatasetPath, `Dataset file already exists for project: ${path.basename(targetProjectPath)}`);
  }

  const sourceSettingsPath = getWorkflowProjectSettingsPath(sourceProjectPath);
  const targetSettingsPath = getWorkflowProjectSettingsPath(targetProjectPath);
  const sourceSettingsExists = await pathExists(sourceSettingsPath);
  if (sourceSettingsExists) {
    await ensurePathDoesNotExist(targetSettingsPath, `Settings file already exists for project: ${path.basename(targetProjectPath)}`);
  }

  await fs.rename(sourceProjectPath, targetProjectPath);

  if (sourceDatasetExists) {
    await fs.rename(sourceDatasetPath, targetDatasetPath);
  }

  if (sourceSettingsExists) {
    await fs.rename(sourceSettingsPath, targetSettingsPath);
  }

  return {
    project: await getWorkflowProject(root, targetProjectPath),
    movedProjectPaths: [
      {
        fromAbsolutePath: sourceProjectPath,
        toAbsolutePath: targetProjectPath,
      },
    ] satisfies WorkflowProjectPathMove[],
  };
}

async function moveWorkflowFolder(
  root: string,
  sourceRelativePath: unknown,
  destinationFolderRelativePath: unknown,
): Promise<{ folder: Awaited<ReturnType<typeof getWorkflowFolder>>; movedProjectPaths: WorkflowProjectPathMove[] }> {
  const sourceFolderPath = resolveWorkflowRelativePath(root, sourceRelativePath, {
    allowProjectFile: false,
  });
  const destinationFolderPath = resolveWorkflowRelativePath(root, destinationFolderRelativePath, {
    allowProjectFile: false,
    allowEmpty: true,
  });

  if (destinationFolderPath === sourceFolderPath || destinationFolderPath.startsWith(`${sourceFolderPath}${path.sep}`)) {
    throw badRequest('Cannot move a folder into itself');
  }

  const targetFolderPath = validatePath(path.join(destinationFolderPath, path.basename(sourceFolderPath)));
  if (targetFolderPath === sourceFolderPath) {
    return {
      folder: await getWorkflowFolder(root, sourceFolderPath),
      movedProjectPaths: [],
    };
  }

  await ensurePathDoesNotExist(targetFolderPath, `Folder already exists: ${path.basename(targetFolderPath)}`);

  const movedProjectPaths = await getFolderProjectPathMoves(sourceFolderPath, targetFolderPath);

  await fs.rename(sourceFolderPath, targetFolderPath);

  return {
    folder: await getWorkflowFolder(root, targetFolderPath),
    movedProjectPaths,
  };
}

async function getFolderProjectPathMoves(sourceFolderPath: string, targetFolderPath: string): Promise<WorkflowProjectPathMove[]> {
  const projectPaths = await listProjectPathsRecursive(sourceFolderPath);
  return projectPaths.map((projectPath) => ({
    fromAbsolutePath: projectPath,
    toAbsolutePath: validatePath(path.join(targetFolderPath, path.relative(sourceFolderPath, projectPath))),
  }));
}

async function listProjectPathsRecursive(folderPath: string): Promise<string[]> {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const nestedProjectPaths = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => listProjectPathsRecursive(path.join(folderPath, entry.name))),
  );

  return [
    ...entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(PROJECT_EXTENSION))
      .map((entry) => path.join(folderPath, entry.name)),
    ...nestedProjectPaths.flat(),
  ];
}

async function ensurePathDoesNotExist(filePath: string, errorMessage: string) {
  try {
    await fs.access(filePath);
    throw conflict(errorMessage);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getWorkflowProjectSettingsPath(projectPath: string): string {
  return `${projectPath}${PROJECT_SETTINGS_SUFFIX}`;
}

function getPublishedSnapshotsRoot(root: string): string {
  return validatePath(path.join(root, PUBLISHED_SNAPSHOTS_DIR));
}

function getPublishedWorkflowSnapshotPath(root: string, snapshotId: string): string {
  return validatePath(path.join(getPublishedSnapshotsRoot(root), `${snapshotId}${PROJECT_EXTENSION}`));
}

function getPublishedWorkflowSnapshotDatasetPath(root: string, snapshotId: string): string {
  return getWorkflowDatasetPath(getPublishedWorkflowSnapshotPath(root, snapshotId));
}

function getWorkflowDatasetPath(projectPath: string): string {
  return projectPath.replace(PROJECT_EXTENSION, '.rivet-data');
}

async function getWorkflowProjectSettings(projectPath: string, projectName: string): Promise<WorkflowProjectSettings> {
  const storedSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  const currentStateHash = await createWorkflowPublicationStateHash(projectPath, storedSettings.endpointName);
  const status = getDerivedWorkflowProjectStatus(storedSettings, currentStateHash);

  return {
    status,
    endpointName: storedSettings.endpointName,
  };
}

async function readStoredWorkflowProjectSettings(projectPath: string, _projectName: string): Promise<StoredWorkflowProjectSettings> {
  const settingsPath = getWorkflowProjectSettingsPath(projectPath);

  try {
    const settingsText = await fs.readFile(settingsPath, 'utf8');
    const parsedSettings = JSON.parse(settingsText) as unknown;
    return normalizeStoredWorkflowProjectSettings(parsedSettings);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT' || error instanceof SyntaxError) {
      return createDefaultStoredWorkflowProjectSettings();
    }

    throw error;
  }
}

async function writeStoredWorkflowProjectSettings(projectPath: string, settings: StoredWorkflowProjectSettings): Promise<void> {
  await fs.writeFile(getWorkflowProjectSettingsPath(projectPath), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function createDefaultStoredWorkflowProjectSettings(): StoredWorkflowProjectSettings {
  return {
    endpointName: '',
    publishedEndpointName: '',
    publishedSnapshotId: null,
    publishedStateHash: null,
  };
}

function normalizeWorkflowProjectSettingsDraft(value: unknown): WorkflowProjectSettingsDraft {
  const defaultSettings = createDefaultStoredWorkflowProjectSettings();
  const endpointName = typeof (value as WorkflowProjectSettingsDraft | undefined)?.endpointName === 'string'
    ? (value as WorkflowProjectSettingsDraft).endpointName
    : defaultSettings.endpointName;

  return {
    endpointName: normalizeStoredEndpointName(endpointName),
  };
}

function normalizeStoredWorkflowProjectSettings(value: unknown): StoredWorkflowProjectSettings {
  const defaultSettings = createDefaultStoredWorkflowProjectSettings();
  const endpointName = typeof (value as StoredWorkflowProjectSettings | WorkflowProjectSettings | undefined)?.endpointName === 'string'
    ? (value as StoredWorkflowProjectSettings | WorkflowProjectSettings).endpointName
    : defaultSettings.endpointName;
  const publishedEndpointName = typeof (value as StoredWorkflowProjectSettings | undefined)?.publishedEndpointName === 'string'
    ? (value as StoredWorkflowProjectSettings).publishedEndpointName
    : defaultSettings.publishedEndpointName;
  const publishedSnapshotId = typeof (value as StoredWorkflowProjectSettings | undefined)?.publishedSnapshotId === 'string'
    ? (value as StoredWorkflowProjectSettings).publishedSnapshotId
    : (value as StoredWorkflowProjectSettings | undefined)?.publishedSnapshotId === null
      ? null
      : defaultSettings.publishedSnapshotId;
  const publishedStateHash = typeof (value as StoredWorkflowProjectSettings | undefined)?.publishedStateHash === 'string'
    ? (value as StoredWorkflowProjectSettings).publishedStateHash
    : (value as StoredWorkflowProjectSettings | undefined)?.publishedStateHash === null
      ? null
      : defaultSettings.publishedStateHash;
  const legacyStatus = typeof (value as WorkflowProjectSettings | undefined)?.status === 'string'
    ? (value as WorkflowProjectSettings).status
    : undefined;

  if (
    legacyStatus != null &&
    legacyStatus !== 'unpublished' &&
    legacyStatus !== 'published' &&
    legacyStatus !== 'unpublished_changes'
  ) {
    throw badRequest('Invalid project status');
  }

  return {
    endpointName: normalizeStoredEndpointName(endpointName),
    publishedEndpointName: normalizeStoredEndpointName(publishedEndpointName || (publishedStateHash ? endpointName : '')),
    publishedSnapshotId,
    publishedStateHash,
    legacyStatus,
  };
}

function getDerivedWorkflowProjectStatus(
  settings: StoredWorkflowProjectSettings,
  currentStateHash: string,
): WorkflowProjectStatus {
  if (settings.publishedStateHash) {
    return settings.publishedStateHash === currentStateHash ? 'published' : 'unpublished_changes';
  }

  if (settings.legacyStatus === 'published' || settings.legacyStatus === 'unpublished_changes') {
    return settings.legacyStatus;
  }

  return 'unpublished';
}

async function ensureWorkflowEndpointNameIsUnique(root: string, currentProjectPath: string, endpointName: string): Promise<void> {
  if (!endpointName) {
    throw badRequest('Endpoint name is required');
  }

  const projectPaths = await listProjectPathsRecursive(root);

  for (const projectPath of projectPaths) {
    if (projectPath === currentProjectPath) {
      continue;
    }

    const projectName = path.basename(projectPath, PROJECT_EXTENSION);
    const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);

    if (settings.endpointName === endpointName || settings.publishedEndpointName === endpointName) {
      throw conflict(`Endpoint name is already used by ${path.basename(projectPath)}`);
    }
  }
}

async function writePublishedWorkflowSnapshot(root: string, projectPath: string, snapshotId: string): Promise<void> {
  const publishedProjectPath = getPublishedWorkflowSnapshotPath(root, snapshotId);
  const sourceDatasetPath = getWorkflowDatasetPath(projectPath);
  const publishedDatasetPath = getPublishedWorkflowSnapshotDatasetPath(root, snapshotId);
  await fs.mkdir(path.dirname(publishedProjectPath), { recursive: true });
  await fs.copyFile(projectPath, publishedProjectPath);

  if (await pathExists(sourceDatasetPath)) {
    await fs.copyFile(sourceDatasetPath, publishedDatasetPath);
  } else if (await pathExists(publishedDatasetPath)) {
    await fs.rm(publishedDatasetPath, { force: false });
  }
}

async function deletePublishedWorkflowSnapshot(root: string, snapshotId: string | null): Promise<void> {
  if (!snapshotId) {
    return;
  }

  const publishedProjectPath = getPublishedWorkflowSnapshotPath(root, snapshotId);
  const publishedDatasetPath = getPublishedWorkflowSnapshotDatasetPath(root, snapshotId);
  if (await pathExists(publishedProjectPath)) {
    await fs.rm(publishedProjectPath, { force: false });
  }

  if (await pathExists(publishedDatasetPath)) {
    await fs.rm(publishedDatasetPath, { force: false });
  }
}

async function findPublishedWorkflowByEndpoint(root: string, endpointName: string): Promise<PublishedWorkflowMatch | null> {
  const projectPaths = await listProjectPathsRecursive(root);

  for (const projectPath of projectPaths) {
    const projectName = path.basename(projectPath, PROJECT_EXTENSION);
    const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);

    if (!settings.publishedStateHash || settings.publishedEndpointName !== endpointName) {
      continue;
    }

    const publishedProjectPath = await resolvePublishedWorkflowProjectPath(root, projectPath, settings);
    if (!publishedProjectPath) {
      continue;
    }

    return {
      endpointName,
      projectPath,
      publishedProjectPath,
    };
  }

  return null;
}

async function resolvePublishedWorkflowProjectPath(
  root: string,
  projectPath: string,
  settings: StoredWorkflowProjectSettings,
): Promise<string | null> {
  if (settings.publishedSnapshotId) {
    const publishedProjectPath = getPublishedWorkflowSnapshotPath(root, settings.publishedSnapshotId);
    if (await pathExists(publishedProjectPath)) {
      return publishedProjectPath;
    }
  }

  if (!settings.publishedStateHash || !settings.publishedEndpointName) {
    return null;
  }

  const currentStateHash = await createWorkflowPublicationStateHash(projectPath, settings.publishedEndpointName);
  return currentStateHash === settings.publishedStateHash ? projectPath : null;
}

function createPublishedWorkflowProjectReferenceLoader(root: string, rootProjectPath: string) {
  return {
    async loadProject(currentProjectPath: string | undefined, reference: { id: string; hintPaths?: string[]; title?: string }) {
      const baseProjectPath = currentProjectPath ?? rootProjectPath;

      for (const hintPath of reference.hintPaths ?? []) {
        try {
          const resolvedProjectPath = validatePath(path.resolve(path.dirname(baseProjectPath), hintPath));
          if (!resolvedProjectPath.endsWith(PROJECT_EXTENSION)) {
            continue;
          }

          const projectName = path.basename(resolvedProjectPath, PROJECT_EXTENSION);
          const settings = await readStoredWorkflowProjectSettings(resolvedProjectPath, projectName);
          const publishedProjectPath = await resolvePublishedWorkflowProjectPath(root, resolvedProjectPath, settings);
          return await loadProjectFromFile(publishedProjectPath ?? resolvedProjectPath);
        } catch {
          // ignore failed hint path resolutions and continue trying the remaining hint paths
        }
      }

      throw new Error(
        `Could not load project "${reference.title ?? reference.id} (${reference.id})": all hint paths failed. Tried: ${reference.hintPaths}`,
      );
    },
  };
}

async function createWorkflowPublicationStateHash(projectPath: string, endpointName: string): Promise<string> {
  const projectContents = await fs.readFile(projectPath, 'utf8');
  const datasetPath = getWorkflowDatasetPath(projectPath);
  const hash = createHash('sha256').update(endpointName).update('\n').update(projectContents);

  if (await pathExists(datasetPath)) {
    const datasetContents = await fs.readFile(datasetPath, 'utf8');
    hash.update('\n--dataset--\n').update(datasetContents);
  } else {
    hash.update('\n--dataset-missing--\n');
  }

  return hash.digest('hex');
}

function normalizeStoredEndpointName(value: string): string {
  const trimmed = value.trim().toLowerCase();

  if (!trimmed) {
    return '';
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    throw badRequest('Endpoint name must contain only lowercase letters, numbers, and hyphens');
  }

  return trimmed;
}

// JSON-quotes a value for safe embedding in a YAML template
function quoteForYaml(value: string): string {
  return JSON.stringify(value);
}

function createBlankProjectFile(projectName: string): string {
  const projectId = randomUUID();
  const graphId = randomUUID();

  return [
    'version: 4',
    'data:',
    '  metadata:',
    `    id: ${quoteForYaml(projectId)}`,
    `    title: ${quoteForYaml(projectName)}`,
    '    description: ""',
    `    mainGraphId: ${quoteForYaml(graphId)}`,
    '  graphs:',
    `    ${quoteForYaml(graphId)}:`,
    '      metadata:',
    `        id: ${quoteForYaml(graphId)}`,
    '        name: "Main Graph"',
    '        description: ""',
    '      nodes: {}',
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}
