import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkspaceRoot } from '../security.js';
import { asyncHandler } from '../utils/asyncHandler.js';
export const projectsRouter = Router();
// GET /api/projects/list — list .rivet-project files in workspace
projectsRouter.get('/list', asyncHandler(async (_req, res) => {
    const root = getWorkspaceRoot();
    const files = await findProjectFiles(root, 3);
    res.json({ files });
}));
// POST /api/projects/open-dialog — return list of .rivet-project files
projectsRouter.post('/open-dialog', asyncHandler(async (_req, res) => {
    const root = getWorkspaceRoot();
    const files = await findProjectFiles(root, 5);
    res.json({ files });
}));
async function findProjectFiles(dir, maxDepth, depth = 0) {
    if (depth > maxDepth)
        return [];
    const results = [];
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name.endsWith('.rivet-project')) {
                results.push(fullPath);
            }
            else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                const subResults = await findProjectFiles(fullPath, maxDepth, depth + 1);
                results.push(...subResults);
            }
        }
    }
    catch {
        // Skip directories we can't read
    }
    return results;
}
