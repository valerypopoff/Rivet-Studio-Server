import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWorkflowsRoot, validatePath } from '../security.js';
export const workflowsRouter = Router();
const PROJECT_EXTENSION = '.rivet-project';
workflowsRouter.get('/tree', async (_req, res) => {
    try {
        const root = await ensureWorkflowsRoot();
        const folders = await listWorkflowFolders(root);
        const projects = await listWorkflowProjects(root);
        res.json({ root, folders, projects });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
workflowsRouter.post('/move', async (req, res) => {
    try {
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
        throw new Error('Invalid itemType');
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
workflowsRouter.post('/folders', async (req, res) => {
    try {
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
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
workflowsRouter.patch('/folders', async (req, res) => {
    try {
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
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
workflowsRouter.post('/projects', async (req, res) => {
    try {
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
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
async function ensureWorkflowsRoot() {
    const root = getWorkflowsRoot();
    await fs.mkdir(root, { recursive: true });
    return root;
}
function sanitizeWorkflowName(value, label) {
    if (typeof value !== 'string') {
        throw new Error(`Missing ${label}`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error(`Missing ${label}`);
    }
    if (trimmed === '.' || trimmed === '..') {
        throw new Error(`Invalid ${label}`);
    }
    if (/[\\/]/.test(trimmed)) {
        throw new Error(`${label} must not contain path separators`);
    }
    if (/[<>:"|?*]/.test(trimmed)) {
        throw new Error(`${label} contains invalid filesystem characters`);
    }
    return trimmed;
}
function resolveWorkflowRelativePath(root, relativePath, options) {
    if (typeof relativePath !== 'string') {
        if (options.allowEmpty && (relativePath == null || relativePath === '')) {
            return root;
        }
        throw new Error('Missing relativePath');
    }
    const normalized = relativePath.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
    if (!normalized) {
        if (options.allowEmpty) {
            return root;
        }
        throw new Error('Missing relativePath');
    }
    const segments = normalized.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error('Invalid relativePath');
    }
    if (!options.allowProjectFile && normalized.endsWith(PROJECT_EXTENSION)) {
        throw new Error('Expected folder path, received project path');
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
    return {
        id: relativePath,
        name: fileName.slice(0, -PROJECT_EXTENSION.length),
        fileName,
        relativePath,
        absolutePath: filePath,
        updatedAt: stats.mtime.toISOString(),
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
        throw new Error('Expected project path');
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
    await fs.rename(sourceProjectPath, targetProjectPath);
    if (sourceDatasetExists) {
        await fs.rename(sourceDatasetPath, targetDatasetPath);
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
        throw new Error('Cannot move a folder into itself');
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
        throw new Error(errorMessage);
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
function yamlString(value) {
    return JSON.stringify(value);
}
function createBlankProjectFile(projectName) {
    const projectId = randomUUID();
    const graphId = randomUUID();
    return [
        'version: 4',
        'data:',
        '  metadata:',
        `    id: ${yamlString(projectId)}`,
        `    title: ${yamlString(projectName)}`,
        '    description: ""',
        `    mainGraphId: ${yamlString(graphId)}`,
        '  graphs:',
        `    ${yamlString(graphId)}:`,
        '      metadata:',
        `        id: ${yamlString(graphId)}`,
        '        name: "Main Graph"',
        '        description: ""',
        '      nodes: {}',
        '  plugins: []',
        '  references: []',
        '',
    ].join('\n');
}
