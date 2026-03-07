import { Router } from 'express';
import { getAppDataRoot } from '../security.js';
import path from 'node:path';
export const pathRouter = Router();
// GET /api/path/app-local-data-dir
pathRouter.get('/app-local-data-dir', (_req, res) => {
    res.json({ path: getAppDataRoot() });
});
// GET /api/path/app-log-dir
pathRouter.get('/app-log-dir', (_req, res) => {
    res.json({ path: path.join(getAppDataRoot(), 'logs') });
});
