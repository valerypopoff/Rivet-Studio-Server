import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePath, getAppDataRoot } from '../security.js';
import { minimatch } from 'minimatch';
import { asyncHandler } from '../utils/asyncHandler.js';
export const nativeRouter = Router();
// POST /api/native/readdir
nativeRouter.post('/readdir', asyncHandler(async (req, res) => {
    const { path: dirPath, baseDir, options = {} } = req.body;
    const resolvedPath = resolveBaseDir(dirPath, baseDir);
    const safePath = validatePath(resolvedPath);
    const { recursive = false, includeDirectories = false, filterGlobs = [], relative = false, ignores = [] } = options;
    const entries = await readDirRecursive(safePath, recursive);
    let results = entries
        .filter((e) => (includeDirectories ? true : !e.isDirectory))
        .map((e) => e.path);
    if (filterGlobs.length > 0) {
        for (const glob of filterGlobs) {
            results = results.filter((r) => minimatch(r, glob, { dot: true }));
        }
    }
    if (ignores.length > 0) {
        for (const ignore of ignores) {
            results = results.filter((r) => !minimatch(r, ignore, { dot: true }));
        }
    }
    if (relative) {
        results = results.map((r) => path.relative(safePath, r));
    }
    res.json(results);
}));
// POST /api/native/read-text
nativeRouter.post('/read-text', asyncHandler(async (req, res) => {
    const { path: filePath, baseDir } = req.body;
    const resolvedPath = resolveBaseDir(filePath, baseDir);
    const safePath = validatePath(resolvedPath);
    const contents = await fs.readFile(safePath, 'utf-8');
    res.json({ contents });
}));
// POST /api/native/read-binary
nativeRouter.post('/read-binary', asyncHandler(async (req, res) => {
    const { path: filePath, baseDir } = req.body;
    const resolvedPath = resolveBaseDir(filePath, baseDir);
    const safePath = validatePath(resolvedPath);
    const buffer = await fs.readFile(safePath);
    const contents = buffer.toString('base64');
    res.json({ contents });
}));
// POST /api/native/write-text
nativeRouter.post('/write-text', asyncHandler(async (req, res) => {
    const { path: filePath, contents, baseDir } = req.body;
    const resolvedPath = resolveBaseDir(filePath, baseDir);
    const safePath = validatePath(resolvedPath);
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, contents, 'utf-8');
    res.json({ success: true });
}));
// POST /api/native/write-binary
nativeRouter.post('/write-binary', asyncHandler(async (req, res) => {
    const { path: filePath, contents, baseDir } = req.body;
    const resolvedPath = resolveBaseDir(filePath, baseDir);
    const safePath = validatePath(resolvedPath);
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    const buffer = Buffer.from(contents, 'base64');
    await fs.writeFile(safePath, buffer);
    res.json({ success: true });
}));
// POST /api/native/exists
nativeRouter.post('/exists', asyncHandler(async (req, res) => {
    const { path: filePath, baseDir } = req.body;
    const resolvedPath = resolveBaseDir(filePath, baseDir);
    const safePath = validatePath(resolvedPath);
    try {
        await fs.access(safePath);
        res.json({ exists: true });
    }
    catch {
        res.json({ exists: false });
    }
}));
// POST /api/native/mkdir
nativeRouter.post('/mkdir', asyncHandler(async (req, res) => {
    const { path: dirPath, recursive = false } = req.body;
    const safePath = validatePath(dirPath);
    await fs.mkdir(safePath, { recursive });
    res.json({ success: true });
}));
// POST /api/native/remove-dir
nativeRouter.post('/remove-dir', asyncHandler(async (req, res) => {
    const { path: dirPath, recursive = false } = req.body;
    const safePath = validatePath(dirPath);
    await fs.rm(safePath, { recursive, force: true });
    res.json({ success: true });
}));
// POST /api/native/remove-file
nativeRouter.post('/remove-file', asyncHandler(async (req, res) => {
    const { path: filePath, baseDir } = req.body;
    const resolvedPath = resolveBaseDir(filePath, baseDir);
    const safePath = validatePath(resolvedPath);
    await fs.unlink(safePath);
    res.json({ success: true });
}));
// POST /api/native/read-relative
nativeRouter.post('/read-relative', asyncHandler(async (req, res) => {
    const { relativeFrom, projectFilePath } = req.body ?? {};
    if (!relativeFrom || !projectFilePath) {
        res.status(400).json({ error: 'Missing relativeFrom or projectFilePath' });
        return;
    }
    const baseDir = path.dirname(relativeFrom);
    const fullPath = path.resolve(baseDir, projectFilePath);
    const safePath = validatePath(fullPath);
    const contents = await fs.readFile(safePath, 'utf-8');
    res.json({ contents });
}));
// Helper: resolve baseDir to actual path
function resolveBaseDir(inputPath, baseDir) {
    if (!baseDir)
        return inputPath;
    const appDataRoot = getAppDataRoot();
    const baseDirMap = {
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
    if (base) {
        return path.join(base, inputPath);
    }
    return inputPath;
}
async function readDirRecursive(dirPath, recursive) {
    const entries = [];
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    for (const item of items) {
        const fullPath = path.join(dirPath, item.name);
        entries.push({
            path: fullPath,
            name: item.name,
            isDirectory: item.isDirectory(),
        });
        if (recursive && item.isDirectory()) {
            const subEntries = await readDirRecursive(fullPath, true);
            entries.push(...subEntries);
        }
    }
    return entries;
}
