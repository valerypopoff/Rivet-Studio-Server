import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWorkflowsRoot, validatePath } from '../../security.js';
import { badRequest, conflict } from '../../utils/httpError.js';
export const PROJECT_EXTENSION = '.rivet-project';
export const PROJECT_SETTINGS_SUFFIX = '.wrapper-settings.json';
export const PUBLISHED_SNAPSHOTS_DIR = '.published';
export async function ensureWorkflowsRoot() {
    const root = getWorkflowsRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(getPublishedSnapshotsRoot(root), { recursive: true });
    return root;
}
export function sanitizeWorkflowName(value, label) {
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
export function resolveWorkflowRelativePath(root, relativePath, options) {
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
export async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
export async function ensurePathDoesNotExist(filePath, errorMessage) {
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
export function getWorkflowProjectSettingsPath(projectPath) {
    return `${projectPath}${PROJECT_SETTINGS_SUFFIX}`;
}
export function getPublishedSnapshotsRoot(root) {
    return validatePath(path.join(root, PUBLISHED_SNAPSHOTS_DIR));
}
export function getPublishedWorkflowSnapshotPath(root, snapshotId) {
    return validatePath(path.join(getPublishedSnapshotsRoot(root), `${snapshotId}${PROJECT_EXTENSION}`));
}
export function getPublishedWorkflowSnapshotDatasetPath(root, snapshotId) {
    return getWorkflowDatasetPath(getPublishedWorkflowSnapshotPath(root, snapshotId));
}
export function getWorkflowDatasetPath(projectPath) {
    return projectPath.replace(PROJECT_EXTENSION, '.rivet-data');
}
export function getProjectSidecarPaths(projectPath) {
    return {
        dataset: getWorkflowDatasetPath(projectPath),
        settings: getWorkflowProjectSettingsPath(projectPath),
    };
}
export async function listProjectPathsRecursive(folderPath) {
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
export function quoteForYaml(value) {
    return JSON.stringify(value);
}
export function createBlankProjectFile(projectName) {
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
