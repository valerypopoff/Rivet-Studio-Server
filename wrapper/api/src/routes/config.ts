import { Router } from 'express';
import path from 'node:path';
import { LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH } from '../latestWorkflowRemoteDebugger.js';
import { getAppDataRoot, isEnvAllowed } from '../security.js';
import { LATEST_WORKFLOWS_BASE_PATH, PUBLISHED_WORKFLOWS_BASE_PATH } from '../workflowEndpointPaths.js';

export const configRouter = Router();

// GET /api/config — return runtime configuration
configRouter.get('/config', (_req, res) => {
  res.json({
    hostedMode: true,
    executorWsUrl: process.env.RIVET_EXECUTOR_WS_URL ?? 'ws://localhost/ws/executor/internal',
    remoteDebuggerDefaultWs: process.env.RIVET_REMOTE_DEBUGGER_DEFAULT_WS ?? `ws://localhost${LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH}`,
    apiBaseUrl: '/api',
    publishedWorkflowsBasePath: PUBLISHED_WORKFLOWS_BASE_PATH,
    latestWorkflowsBasePath: LATEST_WORKFLOWS_BASE_PATH,
  });
});

// GET /api/path/app-local-data-dir
configRouter.get('/path/app-local-data-dir', (_req, res) => {
  res.json({ path: getAppDataRoot() });
});

// GET /api/path/app-log-dir
configRouter.get('/path/app-log-dir', (_req, res) => {
  res.json({ path: path.join(getAppDataRoot(), 'logs') });
});

// GET /api/config/env/:name
configRouter.get('/config/env/:name', (req, res) => {
  const name = String(req.params.name ?? '');

  if (!name) {
    res.status(400).json({ error: 'Missing env var name' });
    return;
  }

  if (!isEnvAllowed(name)) {
    res.json({ value: '' });
    return;
  }

  res.json({ value: process.env[name] ?? '' });
});
