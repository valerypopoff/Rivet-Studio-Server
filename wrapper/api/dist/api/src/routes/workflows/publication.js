import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadProjectFromFile } from '@ironclad/rivet-node';
import { validatePath } from '../../security.js';
import { badRequest, conflict } from '../../utils/httpError.js';
import { getPublishedWorkflowSnapshotDatasetPath, getPublishedWorkflowSnapshotPath, getWorkflowDatasetPath, getWorkflowProjectSettingsPath, listProjectPathsRecursive, pathExists, PROJECT_EXTENSION, } from './fs-helpers.js';
export async function getWorkflowProjectSettings(projectPath, projectName) {
    const storedSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
    const currentStateHash = await createWorkflowPublicationStateHash(projectPath, storedSettings.endpointName);
    const status = getDerivedWorkflowProjectStatus(storedSettings, currentStateHash);
    return {
        status,
        endpointName: storedSettings.endpointName,
    };
}
export async function readStoredWorkflowProjectSettings(projectPath, _projectName) {
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
export async function writeStoredWorkflowProjectSettings(projectPath, settings) {
    await fs.writeFile(getWorkflowProjectSettingsPath(projectPath), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}
export function createDefaultStoredWorkflowProjectSettings() {
    return {
        endpointName: '',
        publishedEndpointName: '',
        publishedSnapshotId: null,
        publishedStateHash: null,
    };
}
export function normalizeWorkflowProjectSettingsDraft(value) {
    const defaults = createDefaultStoredWorkflowProjectSettings();
    const raw = (value ?? {});
    const endpointName = typeof raw.endpointName === 'string' ? raw.endpointName : defaults.endpointName;
    return {
        endpointName: normalizeStoredEndpointName(endpointName),
    };
}
export function normalizeStoredWorkflowProjectSettings(value) {
    const defaults = createDefaultStoredWorkflowProjectSettings();
    const raw = (value ?? {});
    const endpointName = typeof raw.endpointName === 'string' ? raw.endpointName : defaults.endpointName;
    const publishedEndpointName = typeof raw.publishedEndpointName === 'string'
        ? raw.publishedEndpointName
        : defaults.publishedEndpointName;
    const publishedSnapshotId = typeof raw.publishedSnapshotId === 'string'
        ? raw.publishedSnapshotId
        : raw.publishedSnapshotId === null
            ? null
            : defaults.publishedSnapshotId;
    const publishedStateHash = typeof raw.publishedStateHash === 'string'
        ? raw.publishedStateHash
        : raw.publishedStateHash === null
            ? null
            : defaults.publishedStateHash;
    const legacyStatus = typeof raw.status === 'string' ? raw.status : undefined;
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
export function getDerivedWorkflowProjectStatus(settings, currentStateHash) {
    if (settings.publishedStateHash) {
        return settings.publishedStateHash === currentStateHash ? 'published' : 'unpublished_changes';
    }
    if (settings.legacyStatus === 'published' || settings.legacyStatus === 'unpublished_changes') {
        return settings.legacyStatus;
    }
    return 'unpublished';
}
export function normalizeStoredEndpointName(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }
    if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(trimmed)) {
        throw badRequest('Endpoint name must contain only letters, numbers, and hyphens');
    }
    return trimmed;
}
export function normalizeWorkflowEndpointLookupName(value) {
    return normalizeStoredEndpointName(value).toLowerCase();
}
export function isWorkflowEndpointPublished(settings, endpointName) {
    if (normalizeWorkflowEndpointLookupName(settings.publishedEndpointName) !== normalizeWorkflowEndpointLookupName(endpointName)) {
        return false;
    }
    if (settings.publishedStateHash) {
        return true;
    }
    return settings.legacyStatus === 'published' || settings.legacyStatus === 'unpublished_changes';
}
export async function ensureWorkflowEndpointNameIsUnique(root, currentProjectPath, endpointName) {
    if (!endpointName) {
        throw badRequest('Endpoint name is required');
    }
    const requestedLookupName = normalizeWorkflowEndpointLookupName(endpointName);
    const projectPaths = await listProjectPathsRecursive(root);
    for (const projectPath of projectPaths) {
        if (projectPath === currentProjectPath) {
            continue;
        }
        const projectName = path.basename(projectPath, PROJECT_EXTENSION);
        const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);
        if (normalizeWorkflowEndpointLookupName(settings.endpointName) === requestedLookupName ||
            normalizeWorkflowEndpointLookupName(settings.publishedEndpointName) === requestedLookupName) {
            throw conflict(`Endpoint name is already used by ${path.basename(projectPath)}`);
        }
    }
}
export async function createWorkflowPublicationStateHash(projectPath, endpointName) {
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
export async function writePublishedWorkflowSnapshot(root, projectPath, snapshotId) {
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
export async function deletePublishedWorkflowSnapshot(root, snapshotId) {
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
export async function resolvePublishedWorkflowProjectPath(root, projectPath, settings) {
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
export async function findPublishedWorkflowByEndpoint(root, endpointName) {
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
export async function findLatestWorkflowByEndpoint(root, endpointName) {
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
export function createPublishedWorkflowProjectReferenceLoader(root, rootProjectPath) {
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
                }
            }
            throw new Error(`Could not load project "${reference.title ?? reference.id} (${reference.id})": all hint paths failed. Tried: ${reference.hintPaths}`);
        },
    };
}
