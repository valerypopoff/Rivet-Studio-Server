import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { minimatch } from 'minimatch';

import type { WorkflowFolderItem } from '../../../shared/workflow-types.js';
import { getAppDataRoot, validatePath } from '../security.js';
import { badRequest, createHttpError } from '../utils/httpError.js';
import {
  WORKFLOW_DATASET_EXTENSION,
  WORKFLOW_PROJECT_EXTENSION,
  getManagedWorkflowVirtualDatasetPath,
} from '../../../shared/workflow-types.js';
import { isManagedWorkflowStorageEnabled } from './workflows/storage-config.js';
import {
  getWorkflowTree,
  managedHostedPathExists,
  readManagedHostedRelativeProject,
  readManagedHostedText,
} from './workflows/storage-backend.js';
import {
  getManagedWorkflowVirtualRoot,
  isManagedWorkflowVirtualReference,
} from './workflows/virtual-paths.js';

export const SUPPORTED_NATIVE_BASE_DIRS = [
  'app',
  'appCache',
  'appConfig',
  'appData',
  'appLocalData',
  'appLog',
  'home',
  'temp',
] as const;

export type NativeBaseDir = (typeof SUPPORTED_NATIVE_BASE_DIRS)[number];

const getNativeBaseDirMap = (): Record<NativeBaseDir, string> => {
  const appDataRoot = getAppDataRoot();
  return {
    app: appDataRoot,
    appCache: path.join(appDataRoot, 'cache'),
    appConfig: path.join(appDataRoot, 'config'),
    appData: appDataRoot,
    appLocalData: appDataRoot,
    appLog: path.join(appDataRoot, 'logs'),
    home: os.homedir(),
    temp: os.tmpdir(),
  };
};

type ReadDirOptions = {
  recursive: boolean;
  includeDirectories: boolean;
  filterGlobs: string[];
  relative: boolean;
  ignores: string[];
};

type DirEntry = {
  path: string;
  name: string;
  isDirectory: boolean;
};

type ManagedVirtualEntry = {
  path: string;
  isDirectory: boolean;
};

export function applyReadDirFilters(paths: string[], options: Pick<ReadDirOptions, 'filterGlobs' | 'ignores'>): string[] {
  let results = paths;

  for (const glob of options.filterGlobs) {
    results = results.filter((candidate) => minimatch(candidate, glob, { dot: true }));
  }

  for (const ignore of options.ignores) {
    results = results.filter((candidate) => !minimatch(candidate, ignore, { dot: true }));
  }

  return results;
}

function normalizeManagedVirtualPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || getManagedWorkflowVirtualRoot();
}

async function listManagedVirtualEntries(): Promise<ManagedVirtualEntry[]> {
  const tree = await getWorkflowTree();
  const entries: ManagedVirtualEntry[] = [
    {
      path: getManagedWorkflowVirtualRoot(),
      isDirectory: true,
    },
  ];
  const projectPaths: string[] = [];

  const visitFolders = (folders: WorkflowFolderItem[]) => {
    for (const folder of folders) {
      entries.push({
        path: normalizeManagedVirtualPath(folder.absolutePath),
        isDirectory: true,
      });
      projectPaths.push(...folder.projects.map((project) => normalizeManagedVirtualPath(project.absolutePath)));
      visitFolders(folder.folders);
    }
  };

  projectPaths.push(...tree.projects.map((project) => normalizeManagedVirtualPath(project.absolutePath)));
  visitFolders(tree.folders);

  for (const projectPath of projectPaths) {
    entries.push({
      path: projectPath,
      isDirectory: false,
    });
  }

  const datasetEntries: ManagedVirtualEntry[] = [];
  for (const projectPath of projectPaths) {
    const datasetPath = getManagedWorkflowVirtualDatasetPath(projectPath);
    if (!datasetPath || !(await managedHostedPathExists(datasetPath))) {
      continue;
    }

    datasetEntries.push({
      path: normalizeManagedVirtualPath(datasetPath),
      isDirectory: false,
    });
  }

  entries.push(...datasetEntries);

  return entries
    .sort((left, right) => left.path.localeCompare(right.path))
    .filter((entry, index, all) => index === 0 || entry.path !== all[index - 1]!.path);
}

export function resolveNativePath(inputPath: string, baseDir?: NativeBaseDir): string {
  if (!baseDir) {
    return validatePath(inputPath);
  }

  const base = getNativeBaseDirMap()[baseDir];
  if (!base) {
    throw badRequest(`Invalid baseDir: ${baseDir}`);
  }

  return validatePath(path.join(base, inputPath));
}

export async function listNativeDirectory(dirPath: string, baseDir: NativeBaseDir | undefined, options: ReadDirOptions): Promise<string[]> {
  if (!baseDir && isManagedWorkflowStorageEnabled() && isManagedWorkflowVirtualReference(dirPath)) {
    const root = getManagedWorkflowVirtualRoot();
    const normalizedDirPath = normalizeManagedVirtualPath(dirPath);
    const entries = await listManagedVirtualEntries();

    if (normalizedDirPath !== root) {
      const targetEntry = entries.find((entry) => entry.path === normalizedDirPath);
      if (!targetEntry) {
        throw createHttpError(404, 'Directory not found');
      }

      if (!targetEntry.isDirectory) {
        throw badRequest('Path is not a directory');
      }
    }

    const prefix = normalizedDirPath === root ? `${root}/` : `${normalizedDirPath}/`;
    let results = entries
      .filter((entry) => entry.path !== normalizedDirPath && entry.path.startsWith(prefix))
      .filter((entry) => options.recursive || !entry.path.slice(prefix.length).includes('/'));

    if (!options.includeDirectories) {
      results = results.filter((entry) => !entry.isDirectory);
    }

    const filteredPaths = applyReadDirFilters(
      results.map((entry) => entry.path),
      options,
    );

    return filteredPaths
      .map((entryPath) => options.relative ? entryPath.slice(prefix.length) : entryPath)
      .sort((left, right) => left.localeCompare(right));
  }

  const safePath = resolveNativePath(dirPath, baseDir);
  const entries = await readDirRecursive(safePath, options.recursive);

  let results = entries
    .filter((entry) => options.includeDirectories ? true : !entry.isDirectory)
    .map((entry) => entry.path);

  results = applyReadDirFilters(results, options);

  if (options.relative) {
    results = results.map((candidate) => path.relative(safePath, candidate));
  }

  return results;
}

export async function readNativeText(filePath: string, baseDir?: NativeBaseDir): Promise<string> {
  if (!baseDir && isManagedWorkflowStorageEnabled() && isManagedWorkflowVirtualReference(filePath)) {
    return readManagedHostedText(filePath);
  }

  return fs.readFile(resolveNativePath(filePath, baseDir), 'utf-8');
}

export async function readNativeBinary(filePath: string, baseDir?: NativeBaseDir): Promise<string> {
  if (!baseDir && isManagedWorkflowStorageEnabled() && isManagedWorkflowVirtualReference(filePath)) {
    const contents = await readManagedHostedText(filePath);
    return Buffer.from(contents, 'utf8').toString('base64');
  }

  const buffer = await fs.readFile(resolveNativePath(filePath, baseDir));
  return buffer.toString('base64');
}

export async function writeNativeText(filePath: string, contents: string, baseDir?: NativeBaseDir): Promise<void> {
  if (!baseDir && isManagedWorkflowStorageEnabled() && isManagedWorkflowVirtualReference(filePath)) {
    throw badRequest('Managed workflow projects must be saved via the project save API');
  }

  const safePath = resolveNativePath(filePath, baseDir);
  await fs.mkdir(path.dirname(safePath), { recursive: true });
  await fs.writeFile(safePath, contents, 'utf-8');
}

export async function writeNativeBinary(filePath: string, contents: string, baseDir?: NativeBaseDir): Promise<void> {
  if (!baseDir && isManagedWorkflowStorageEnabled() && isManagedWorkflowVirtualReference(filePath)) {
    throw badRequest('Managed workflow projects must be saved via the project save API');
  }

  const safePath = resolveNativePath(filePath, baseDir);
  await fs.mkdir(path.dirname(safePath), { recursive: true });
  await fs.writeFile(safePath, Buffer.from(contents, 'base64'));
}

export async function nativePathExists(filePath: string, baseDir?: NativeBaseDir): Promise<boolean> {
  if (!baseDir && isManagedWorkflowStorageEnabled() && isManagedWorkflowVirtualReference(filePath)) {
    const normalizedPath = normalizeManagedVirtualPath(filePath);
    if (normalizedPath === getManagedWorkflowVirtualRoot()) {
      return true;
    }

     if (
      normalizedPath.endsWith(WORKFLOW_PROJECT_EXTENSION) ||
      normalizedPath.endsWith(WORKFLOW_DATASET_EXTENSION)
    ) {
      return managedHostedPathExists(normalizedPath);
    }

    const entries = await listManagedVirtualEntries();
    return entries.some((entry) => entry.path === normalizedPath);
  }

  try {
    await fs.access(resolveNativePath(filePath, baseDir));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

export async function mkdirNativePath(dirPath: string, recursive: boolean): Promise<void> {
  await fs.mkdir(resolveNativePath(dirPath), { recursive });
}

export async function removeNativeDirectory(dirPath: string, recursive: boolean): Promise<void> {
  await fs.rm(resolveNativePath(dirPath), { recursive, force: true });
}

export async function removeNativeFile(filePath: string, baseDir?: NativeBaseDir): Promise<void> {
  if (!baseDir && isManagedWorkflowStorageEnabled() && isManagedWorkflowVirtualReference(filePath)) {
    throw badRequest('Managed workflow files cannot be removed through native IO');
  }

  await fs.unlink(resolveNativePath(filePath, baseDir));
}

export async function readNativeRelative(relativeFrom: string, projectFilePath: string): Promise<string> {
  if (isManagedWorkflowStorageEnabled() && isManagedWorkflowVirtualReference(relativeFrom)) {
    return readManagedHostedRelativeProject(relativeFrom, projectFilePath);
  }

  const fullPath = path.resolve(path.dirname(relativeFrom), projectFilePath);
  return fs.readFile(validatePath(fullPath), 'utf-8');
}

async function readDirRecursive(dirPath: string, recursive: boolean): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  const items = await fs.readdir(dirPath, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);
    entries.push({
      path: fullPath,
      name: item.name,
      isDirectory: item.isDirectory(),
    });

    if (recursive && item.isDirectory()) {
      entries.push(...await readDirRecursive(fullPath, true));
    }
  }

  return entries;
}
