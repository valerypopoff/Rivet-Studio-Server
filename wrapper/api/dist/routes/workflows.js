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
export const latestWorkflowsRouter = Router();
const PROJECT_EXTENSION = '.rivet-project';
const PROJECT_SETTINGS_SUFFIX = '.wrapper-settings.json';
const PUBLISHED_SNAPSHOTS_DIR = '.published';
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
    }
    catch (error) {
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
latestWorkflowsRouter.post('/:endpointName', asyncHandler(async (req, res) => {
    const root = await ensureWorkflowsRoot();
    const endpointName = normalizeStoredEndpointName(String(req.params.endpointName ?? ''));
    if (!endpointName) {
        throw badRequest('Endpoint name is required');
    }
    const latestWorkflow = await findLatestWorkflowByEndpoint(root, endpointName);
    if (!latestWorkflow) {
        res.status(404).json({ error: 'Latest workflow not found' });
        return;
    }
    try {
        const project = await loadProjectFromFile(latestWorkflow.projectPath);
        const datasetProvider = await NodeDatasetProvider.fromProjectFile(latestWorkflow.projectPath);
        const projectReferenceLoader = createPublishedWorkflowProjectReferenceLoader(root, latestWorkflow.projectPath);
        const outputs = await runGraph(project, {
            projectPath: latestWorkflow.projectPath,
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
    }
    catch (error) {
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
    }
    catch {
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
        }
        catch {
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
    }
    catch {
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
        }
        catch {
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
async function ensureWorkflowsRoot() {
    const root = getWorkflowsRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(getPublishedSnapshotsRoot(root), { recursive: true });
    return root;
}
function sanitizeWorkflowName(value, label) {
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
function resolveWorkflowRelativePath(root, relativePath, options) {
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
async function listWorkflowFolders(root) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const folders = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => getWorkflowFolder(root, path.join(root, entry.name))));
    return folders;
}
async function listWorkflowProjects(root) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const projects = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(PROJECT_EXTENSION))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => getWorkflowProject(root, path.join(root, entry.name))));
    return projects;
}
async function getWorkflowFolder(root, folderPath) {
    const stats = await fs.stat(folderPath);
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const folders = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => getWorkflowFolder(root, path.join(folderPath, entry.name))));
    const projects = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(PROJECT_EXTENSION))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => getWorkflowProject(root, path.join(folderPath, entry.name))));
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
async function getWorkflowProject(root, filePath) {
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
async function moveWorkflowProject(root, sourceRelativePath, destinationFolderRelativePath) {
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
        ],
    };
}
async function moveWorkflowFolder(root, sourceRelativePath, destinationFolderRelativePath) {
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
async function getFolderProjectPathMoves(sourceFolderPath, targetFolderPath) {
    const projectPaths = await listProjectPathsRecursive(sourceFolderPath);
    return projectPaths.map((projectPath) => ({
        fromAbsolutePath: projectPath,
        toAbsolutePath: validatePath(path.join(targetFolderPath, path.relative(sourceFolderPath, projectPath))),
    }));
}
async function listProjectPathsRecursive(folderPath) {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const nestedProjectPaths = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => listProjectPathsRecursive(path.join(folderPath, entry.name))));
    return [
        ...entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(PROJECT_EXTENSION))
            .map((entry) => path.join(folderPath, entry.name)),
        ...nestedProjectPaths.flat(),
    ];
}
async function ensurePathDoesNotExist(filePath, errorMessage) {
    try {
        await fs.access(filePath);
        throw conflict(errorMessage);
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
}
async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
function getWorkflowProjectSettingsPath(projectPath) {
    return `${projectPath}${PROJECT_SETTINGS_SUFFIX}`;
}
function getPublishedSnapshotsRoot(root) {
    return validatePath(path.join(root, PUBLISHED_SNAPSHOTS_DIR));
}
function getPublishedWorkflowSnapshotPath(root, snapshotId) {
    return validatePath(path.join(getPublishedSnapshotsRoot(root), `${snapshotId}${PROJECT_EXTENSION}`));
}
function getPublishedWorkflowSnapshotDatasetPath(root, snapshotId) {
    return getWorkflowDatasetPath(getPublishedWorkflowSnapshotPath(root, snapshotId));
}
function getWorkflowDatasetPath(projectPath) {
    return projectPath.replace(PROJECT_EXTENSION, '.rivet-data');
}
async function getWorkflowProjectSettings(projectPath, projectName) {
    const storedSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
    const currentStateHash = await createWorkflowPublicationStateHash(projectPath, storedSettings.endpointName);
    const status = getDerivedWorkflowProjectStatus(storedSettings, currentStateHash);
    return {
        status,
        endpointName: storedSettings.endpointName,
    };
}
async function readStoredWorkflowProjectSettings(projectPath, _projectName) {
    const settingsPath = getWorkflowProjectSettingsPath(projectPath);
    try {
        const settingsText = await fs.readFile(settingsPath, 'utf8');
        const parsedSettings = JSON.parse(settingsText);
        return normalizeStoredWorkflowProjectSettings(parsedSettings);
    }
    catch (error) {
        const errorCode = error.code;
        if (errorCode === 'ENOENT' || error instanceof SyntaxError) {
            return createDefaultStoredWorkflowProjectSettings();
        }
        throw error;
    }
}
async function writeStoredWorkflowProjectSettings(projectPath, settings) {
    await fs.writeFile(getWorkflowProjectSettingsPath(projectPath), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}
function createDefaultStoredWorkflowProjectSettings() {
    return {
        endpointName: '',
        publishedEndpointName: '',
        publishedSnapshotId: null,
        publishedStateHash: null,
    };
}
function normalizeWorkflowProjectSettingsDraft(value) {
    const defaultSettings = createDefaultStoredWorkflowProjectSettings();
    const endpointName = typeof value?.endpointName === 'string'
        ? value.endpointName
        : defaultSettings.endpointName;
    return {
        endpointName: normalizeStoredEndpointName(endpointName),
    };
}
function normalizeStoredWorkflowProjectSettings(value) {
    const defaultSettings = createDefaultStoredWorkflowProjectSettings();
    const endpointName = typeof value?.endpointName === 'string'
        ? value.endpointName
        : defaultSettings.endpointName;
    const publishedEndpointName = typeof value?.publishedEndpointName === 'string'
        ? value.publishedEndpointName
        : defaultSettings.publishedEndpointName;
    const publishedSnapshotId = typeof value?.publishedSnapshotId === 'string'
        ? value.publishedSnapshotId
        : value?.publishedSnapshotId === null
            ? null
            : defaultSettings.publishedSnapshotId;
    const publishedStateHash = typeof value?.publishedStateHash === 'string'
        ? value.publishedStateHash
        : value?.publishedStateHash === null
            ? null
            : defaultSettings.publishedStateHash;
    const legacyStatus = typeof value?.status === 'string'
        ? value.status
        : undefined;
    if (legacyStatus != null &&
        legacyStatus !== 'unpublished' &&
        legacyStatus !== 'published' &&
        legacyStatus !== 'unpublished_changes') {
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
function getDerivedWorkflowProjectStatus(settings, currentStateHash) {
    if (settings.publishedStateHash) {
        return settings.publishedStateHash === currentStateHash ? 'published' : 'unpublished_changes';
    }
    if (settings.legacyStatus === 'published' || settings.legacyStatus === 'unpublished_changes') {
        return settings.legacyStatus;
    }
    return 'unpublished';
}
async function ensureWorkflowEndpointNameIsUnique(root, currentProjectPath, endpointName) {
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
async function writePublishedWorkflowSnapshot(root, projectPath, snapshotId) {
    const publishedProjectPath = getPublishedWorkflowSnapshotPath(root, snapshotId);
    const sourceDatasetPath = getWorkflowDatasetPath(projectPath);
    const publishedDatasetPath = getPublishedWorkflowSnapshotDatasetPath(root, snapshotId);
    await fs.mkdir(path.dirname(publishedProjectPath), { recursive: true });
    await fs.copyFile(projectPath, publishedProjectPath);
    if (await pathExists(sourceDatasetPath)) {
        await fs.copyFile(sourceDatasetPath, publishedDatasetPath);
    }
    else if (await pathExists(publishedDatasetPath)) {
        await fs.rm(publishedDatasetPath, { force: false });
    }
}
async function deletePublishedWorkflowSnapshot(root, snapshotId) {
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
async function findPublishedWorkflowByEndpoint(root, endpointName) {
    const projectPaths = await listProjectPathsRecursive(root);
    for (const projectPath of projectPaths) {
        const projectName = path.basename(projectPath, PROJECT_EXTENSION);
        const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);
        if (!isWorkflowEndpointPublished(settings, endpointName)) {
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
async function findLatestWorkflowByEndpoint(root, endpointName) {
    const projectPaths = await listProjectPathsRecursive(root);
    for (const projectPath of projectPaths) {
        const projectName = path.basename(projectPath, PROJECT_EXTENSION);
        const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);
        if (!isWorkflowEndpointPublished(settings, endpointName)) {
            continue;
        }
        return {
            endpointName,
            projectPath,
        };
    }
    return null;
}
async function resolvePublishedWorkflowProjectPath(root, projectPath, settings) {
    if (settings.publishedSnapshotId) {
        const publishedProjectPath = getPublishedWorkflowSnapshotPath(root, settings.publishedSnapshotId);
        if (await pathExists(publishedProjectPath)) {
            return publishedProjectPath;
        }
    }
    if (!settings.publishedEndpointName) {
        return null;
    }
    if (!settings.publishedStateHash) {
        if (settings.legacyStatus === 'published' || settings.legacyStatus === 'unpublished_changes') {
            return projectPath;
        }
        return null;
    }
    const currentStateHash = await createWorkflowPublicationStateHash(projectPath, settings.publishedEndpointName);
    return currentStateHash === settings.publishedStateHash ? projectPath : null;
}
function isWorkflowEndpointPublished(settings, endpointName) {
    if (settings.publishedEndpointName !== endpointName) {
        return false;
    }
    if (settings.publishedStateHash) {
        return true;
    }
    return settings.legacyStatus === 'published' || settings.legacyStatus === 'unpublished_changes';
}
function createPublishedWorkflowProjectReferenceLoader(root, rootProjectPath) {
    return {
        async loadProject(currentProjectPath, reference) {
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
                }
                catch {
                    // ignore failed hint path resolutions and continue trying the remaining hint paths
                }
            }
            throw new Error(`Could not load project "${reference.title ?? reference.id} (${reference.id})": all hint paths failed. Tried: ${reference.hintPaths}`);
        },
    };
}
async function createWorkflowPublicationStateHash(projectPath, endpointName) {
    const projectContents = await fs.readFile(projectPath, 'utf8');
    const datasetPath = getWorkflowDatasetPath(projectPath);
    const hash = createHash('sha256').update(endpointName).update('\n').update(projectContents);
    if (await pathExists(datasetPath)) {
        const datasetContents = await fs.readFile(datasetPath, 'utf8');
        hash.update('\n--dataset--\n').update(datasetContents);
    }
    else {
        hash.update('\n--dataset-missing--\n');
    }
    return hash.digest('hex');
}
function normalizeStoredEndpointName(value) {
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
function quoteForYaml(value) {
    return JSON.stringify(value);
}
function createBlankProjectFile(projectName) {
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
