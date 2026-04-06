import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
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
import { disposeRuntimeLibrariesBackend } from './runtime-libraries/backend.js';
import { initializeLatestWorkflowRemoteDebugger } from './latestWorkflowRemoteDebugger.js';
import { LATEST_WORKFLOWS_BASE_PATH, PUBLISHED_WORKFLOWS_BASE_PATH } from './workflowEndpointPaths.js';
import { requireAuth } from './middleware/auth.js';
import { initializeWorkflowStorage } from './routes/workflows/storage-backend.js';

const app = express();
const server = createServer(app);
const PORT = parseInt(process.env.PORT ?? '3100', 10);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '100mb', strict: false }));
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

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as any).status ?? 500;
  console.error('Unhandled API error:', err);
  if (status >= 500) {
    res.status(status).json({ error: 'Internal server error' });
    return;
  }

  res.status(status).json({ error: err.message });
});

initializeLatestWorkflowRemoteDebugger(server);

let shuttingDown = false;
const SHUTDOWN_GRACE_MS = 5_000;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[rivet-api] Received ${signal}, shutting down...`);

  try {
    let resolved = false;
    await Promise.race([
      new Promise<void>((resolve) => {
        server.close(() => {
          resolved = true;
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!resolved) {
            console.warn(`[rivet-api] HTTP server did not close within ${SHUTDOWN_GRACE_MS}ms; forcing connection shutdown.`);
            server.closeAllConnections?.();
            server.closeIdleConnections?.();
          }
          resolve();
        }, SHUTDOWN_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    console.error('[rivet-api] Failed to close HTTP server:', error);
  }

  await disposeRuntimeLibrariesBackend().catch((error) => {
    console.error('[runtime-libraries] Failed to dispose backend during shutdown:', error);
  });

  process.exitCode = 0;
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

async function startServer() {
  try {
    await reconcileRuntimeLibraries();
    await initializeWorkflowStorage();
  } catch (error) {
    console.error('[rivet-api] Startup reconciliation failed:', error);
    process.exitCode = 1;
    return;
  }

  server.listen(PORT, () => {
    console.log(`[rivet-api] Listening on port ${PORT}`);
    console.log(`[rivet-api] Workspace root: ${process.env.RIVET_WORKSPACE_ROOT ?? '/workspace'}`);
    console.log(`[rivet-api] App data root: ${process.env.RIVET_APP_DATA_ROOT ?? '/data/rivet-app'}`);
    console.log(`[rivet-api] Runtime libraries root: ${process.env.RIVET_RUNTIME_LIBRARIES_ROOT ?? '(not set)'}`);
  });
}

void startServer();
