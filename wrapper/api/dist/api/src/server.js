import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import cors from 'cors';
import { nativeRouter } from './routes/native.js';
import { shellRouter } from './routes/shell.js';
import { pluginsRouter } from './routes/plugins.js';
import { projectsRouter } from './routes/projects.js';
import { internalPublishedWorkflowsRouter, latestWorkflowsRouter, publishedWorkflowsRouter, workflowsRouter } from './routes/workflows/index.js';
import { configRouter } from './routes/config.js';
import { uiAuthRouter } from './routes/ui-auth.js';
import { runtimeLibrariesRouter } from './routes/runtime-libraries.js';
import { reconcileRuntimeLibraries } from './runtime-libraries/startup.js';
import { initializeLatestWorkflowRemoteDebugger } from './latestWorkflowRemoteDebugger.js';
import { LATEST_WORKFLOWS_BASE_PATH, PUBLISHED_WORKFLOWS_BASE_PATH } from './workflowEndpointPaths.js';
import { requireAuth } from './middleware/auth.js';
const app = express();
const server = createServer(app);
const PORT = parseInt(process.env.PORT ?? '3100', 10);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: false }));
app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
});
// Mount routes
app.use('/', uiAuthRouter);
app.use(PUBLISHED_WORKFLOWS_BASE_PATH, publishedWorkflowsRouter);
app.use(LATEST_WORKFLOWS_BASE_PATH, latestWorkflowsRouter);
app.use('/internal/workflows', internalPublishedWorkflowsRouter);
app.use('/api', requireAuth);
app.use('/api/native', nativeRouter);
app.use('/api/shell', shellRouter);
app.use('/api/plugins', pluginsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/workflows', workflowsRouter);
app.use('/api/runtime-libraries', runtimeLibrariesRouter);
app.use('/api', configRouter);
app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
});
app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    console.error('Unhandled API error:', err);
    if (status >= 500) {
        res.status(status).json({ error: 'Internal server error' });
        return;
    }
    res.status(status).json({ error: err.message });
});
initializeLatestWorkflowRemoteDebugger(server);
server.listen(PORT, () => {
    console.log(`[rivet-api] Listening on port ${PORT}`);
    console.log(`[rivet-api] Workspace root: ${process.env.RIVET_WORKSPACE_ROOT ?? '/workspace'}`);
    console.log(`[rivet-api] App data root: ${process.env.RIVET_APP_DATA_ROOT ?? '/data/rivet-app'}`);
    console.log(`[rivet-api] Runtime libraries root: ${process.env.RIVET_RUNTIME_LIBRARIES_ROOT ?? '(not set)'}`);
    // Run startup reconciliation for runtime libraries (non-blocking)
    reconcileRuntimeLibraries().catch((err) => {
        console.error('[runtime-libraries] Startup reconciliation failed:', err);
    });
});
