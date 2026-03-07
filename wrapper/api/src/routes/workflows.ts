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
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

workflowsRouter.post('/folders', async (req, res) => {
  try {
    const { name } = req.body ?? {};
    const folderName = sanitizeWorkflowName(name, 'folder name');
    const root = await ensureWorkflowsRoot();
    const folderPath = validatePath(path.join(root, folderName));

    try {
      await fs.access(folderPath);
      res.status(409).json({ error: `Folder already exists: ${folderName}` });
      return;
    } catch {
      // expected
    }

    await fs.mkdir(folderPath, { recursive: false });
    res.status(201).json({ folder: await getWorkflowFolder(root, folderPath) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

workflowsRouter.patch('/folders', async (req, res) => {
  try {
    const { relativePath, newName } = req.body ?? {};
    const root = await ensureWorkflowsRoot();
    const currentFolderPath = resolveWorkflowRelativePath(root, relativePath, false);
    const sanitizedName = sanitizeWorkflowName(newName, 'new folder name');
    const renamedFolderPath = validatePath(path.join(root, sanitizedName));

    try {
      await fs.access(renamedFolderPath);
      res.status(409).json({ error: `Folder already exists: ${sanitizedName}` });
      return;
    } catch {
      // expected
    }

    await fs.rename(currentFolderPath, renamedFolderPath);
    res.json({ folder: await getWorkflowFolder(root, renamedFolderPath) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

workflowsRouter.post('/projects', async (req, res) => {
  try {
    const { folderRelativePath, name } = req.body ?? {};
    const root = await ensureWorkflowsRoot();
    const folderPath = resolveWorkflowRelativePath(root, folderRelativePath, false);
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
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

async function ensureWorkflowsRoot(): Promise<string> {
  const root = getWorkflowsRoot();
  await fs.mkdir(root, { recursive: true });
  return root;
}

function sanitizeWorkflowName(value: unknown, label: string): string {
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

function resolveWorkflowRelativePath(root: string, relativePath: unknown, allowProjectFile: boolean): string {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Missing relativePath');
  }

  const normalized = relativePath.replace(/\\/g, '/').trim();

  if (normalized.includes('..')) {
    throw new Error('Invalid relativePath');
  }

  if (!allowProjectFile && normalized.includes('/')) {
    throw new Error('Nested workflow folders are not supported');
  }

  if (!allowProjectFile && normalized.endsWith(PROJECT_EXTENSION)) {
    throw new Error('Expected folder path, received project path');
  }

  const fullPath = validatePath(path.join(root, normalized));
  return fullPath;
}

async function listWorkflowFolders(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const folders = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => getWorkflowFolder(root, path.join(root, entry.name))),
  );

  return folders;
}

async function listWorkflowProjects(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(PROJECT_EXTENSION))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => getWorkflowProject(root, path.join(root, entry.name))),
  );

  return projects;
}

async function getWorkflowFolder(root: string, folderPath: string) {
  const stats = await fs.stat(folderPath);
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
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
    projects,
  };
}

async function getWorkflowProject(root: string, filePath: string) {
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

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function createBlankProjectFile(projectName: string): string {
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
