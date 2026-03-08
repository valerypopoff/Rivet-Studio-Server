import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isEnvAllowed, validatePath } from '../security.js';
import { asyncHandler } from '../utils/asyncHandler.js';
export const compatRouter = Router();
// POST /api/compat/invoke — dispatch by command name
compatRouter.post('/invoke', asyncHandler(async (req, res) => {
    const { command, args = {} } = req.body;
    switch (command) {
        case 'get_environment_variable': {
            const name = args.name;
            if (!name) {
                res.status(400).json({ error: 'Missing env var name' });
                return;
            }
            if (!isEnvAllowed(name)) {
                res.json({ result: '' });
                return;
            }
            res.json({ result: process.env[name] ?? '' });
            return;
        }
        case 'allow_data_file_scope': {
            // No-op in hosted mode — API handles scoping
            res.json({ result: null });
            return;
        }
        case 'read_relative_project_file': {
            const relativeFrom = args.relativeFrom;
            const projectFilePath = args.projectFilePath;
            if (!relativeFrom || !projectFilePath) {
                res.status(400).json({ error: 'Missing relativeFrom or projectFilePath' });
                return;
            }
            const baseDir = path.dirname(relativeFrom);
            const fullPath = path.resolve(baseDir, projectFilePath);
            const safePath = validatePath(fullPath);
            const contents = await fs.readFile(safePath, 'utf-8');
            res.json({ result: contents });
            return;
        }
        case 'extract_package_plugin_tarball': {
            const tarPath = args.path;
            if (!tarPath) {
                res.status(400).json({ error: 'Missing path' });
                return;
            }
            const safePath = validatePath(tarPath);
            const destDir = path.dirname(safePath);
            // Use tar to extract
            const tar = await import('tar');
            await tar.extract({
                file: safePath,
                cwd: destDir,
            });
            res.json({ result: null });
            return;
        }
        default:
            res.status(400).json({ error: `Unknown command: ${command}` });
    }
}));
