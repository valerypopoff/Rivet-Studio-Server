import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { minimatch } from 'minimatch';

import { validateBody } from '../middleware/validate.js';
import { getAppDataRoot, validatePath } from '../security.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const nativeRouter = Router();

const readdirOptionsSchema = z.object({
  recursive: z.boolean().optional().default(false),
  includeDirectories: z.boolean().optional().default(false),
  filterGlobs: z.array(z.string()).optional().default([]),
  relative: z.boolean().optional().default(false),
  ignores: z.array(z.string()).optional().default([]),
});

const readdirSchema = z.object({
  path: z.string().min(1, 'path is required'),
  baseDir: z.string().optional(),
  options: readdirOptionsSchema.optional().default({
    recursive: false,
    includeDirectories: false,
    filterGlobs: [],
    relative: false,
    ignores: [],
  }),
});

const readPathSchema = z.object({
  path: z.string().min(1, 'path is required'),
  baseDir: z.string().optional(),
});

const writeTextSchema = z.object({
  path: z.string().min(1, 'path is required'),
  contents: z.string(),
  baseDir: z.string().optional(),
});

const writeBinarySchema = z.object({
  path: z.string().min(1, 'path is required'),
  contents: z.string(),
  baseDir: z.string().optional(),
});

const mkdirSchema = z.object({
  path: z.string().min(1, 'path is required'),
  recursive: z.boolean().optional().default(false),
});

const readRelativeSchema = z.object({
  relativeFrom: z.string().min(1, 'relativeFrom is required'),
  projectFilePath: z.string().min(1, 'projectFilePath is required'),
});

nativeRouter.post('/readdir', validateBody(readdirSchema), asyncHandler(async (req, res) => {
  const { path: dirPath, baseDir, options } = req.body as z.infer<typeof readdirSchema>;
  const resolvedPath = resolveBaseDir(dirPath, baseDir);
  const safePath = validatePath(resolvedPath);
  const entries = await readDirRecursive(safePath, options.recursive);

  let results = entries
    .filter((entry) => options.includeDirectories ? true : !entry.isDirectory)
    .map((entry) => entry.path);

  if (options.filterGlobs.length > 0) {
    for (const glob of options.filterGlobs) {
      results = results.filter((candidate) => minimatch(candidate, glob, { dot: true }));
    }
  }

  if (options.ignores.length > 0) {
    for (const ignore of options.ignores) {
      results = results.filter((candidate) => !minimatch(candidate, ignore, { dot: true }));
    }
  }

  if (options.relative) {
    results = results.map((candidate) => path.relative(safePath, candidate));
  }

  res.json(results);
}));

nativeRouter.post('/read-text', validateBody(readPathSchema), asyncHandler(async (req, res) => {
  const { path: filePath, baseDir } = req.body as z.infer<typeof readPathSchema>;
  const safePath = validatePath(resolveBaseDir(filePath, baseDir));
  const contents = await fs.readFile(safePath, 'utf-8');
  res.json({ contents });
}));

nativeRouter.post('/read-binary', validateBody(readPathSchema), asyncHandler(async (req, res) => {
  const { path: filePath, baseDir } = req.body as z.infer<typeof readPathSchema>;
  const safePath = validatePath(resolveBaseDir(filePath, baseDir));
  const buffer = await fs.readFile(safePath);
  res.json({ contents: buffer.toString('base64') });
}));

nativeRouter.post('/write-text', validateBody(writeTextSchema), asyncHandler(async (req, res) => {
  const { path: filePath, contents, baseDir } = req.body as z.infer<typeof writeTextSchema>;
  const safePath = validatePath(resolveBaseDir(filePath, baseDir));
  await fs.mkdir(path.dirname(safePath), { recursive: true });
  await fs.writeFile(safePath, contents, 'utf-8');
  res.json({ success: true });
}));

nativeRouter.post('/write-binary', validateBody(writeBinarySchema), asyncHandler(async (req, res) => {
  const { path: filePath, contents, baseDir } = req.body as z.infer<typeof writeBinarySchema>;
  const safePath = validatePath(resolveBaseDir(filePath, baseDir));
  await fs.mkdir(path.dirname(safePath), { recursive: true });
  await fs.writeFile(safePath, Buffer.from(contents, 'base64'));
  res.json({ success: true });
}));

nativeRouter.post('/exists', validateBody(readPathSchema), asyncHandler(async (req, res) => {
  const { path: filePath, baseDir } = req.body as z.infer<typeof readPathSchema>;
  const safePath = validatePath(resolveBaseDir(filePath, baseDir));
  try {
    await fs.access(safePath);
    res.json({ exists: true });
  } catch {
    res.json({ exists: false });
  }
}));

nativeRouter.post('/mkdir', validateBody(mkdirSchema), asyncHandler(async (req, res) => {
  const { path: dirPath, recursive } = req.body as z.infer<typeof mkdirSchema>;
  await fs.mkdir(validatePath(dirPath), { recursive });
  res.json({ success: true });
}));

nativeRouter.post('/remove-dir', validateBody(mkdirSchema), asyncHandler(async (req, res) => {
  const { path: dirPath, recursive } = req.body as z.infer<typeof mkdirSchema>;
  await fs.rm(validatePath(dirPath), { recursive, force: true });
  res.json({ success: true });
}));

nativeRouter.post('/remove-file', validateBody(readPathSchema), asyncHandler(async (req, res) => {
  const { path: filePath, baseDir } = req.body as z.infer<typeof readPathSchema>;
  await fs.unlink(validatePath(resolveBaseDir(filePath, baseDir)));
  res.json({ success: true });
}));

nativeRouter.post('/read-relative', validateBody(readRelativeSchema), asyncHandler(async (req, res) => {
  const { relativeFrom, projectFilePath } = req.body as z.infer<typeof readRelativeSchema>;
  const fullPath = path.resolve(path.dirname(relativeFrom), projectFilePath);
  const safePath = validatePath(fullPath);
  const contents = await fs.readFile(safePath, 'utf-8');
  res.json({ contents });
}));

function resolveBaseDir(inputPath: string, baseDir?: string): string {
  if (!baseDir) {
    return inputPath;
  }

  const appDataRoot = getAppDataRoot();
  const baseDirMap: Record<string, string> = {
    app: appDataRoot,
    appCache: path.join(appDataRoot, 'cache'),
    appConfig: path.join(appDataRoot, 'config'),
    appData: appDataRoot,
    appLocalData: appDataRoot,
    appLog: path.join(appDataRoot, 'logs'),
    home: process.env.HOME ?? '/root',
    temp: '/tmp',
  };

  const base = baseDirMap[baseDir];
  return base ? path.join(base, inputPath) : inputPath;
}

interface DirEntry {
  path: string;
  name: string;
  isDirectory: boolean;
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
