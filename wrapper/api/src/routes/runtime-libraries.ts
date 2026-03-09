import { Router, type Request, type Response } from 'express';

import { asyncHandler } from '../utils/asyncHandler.js';
import { badRequest, conflict } from '../utils/httpError.js';
import { readManifest, readActiveRelease, ensureDirectories } from '../runtime-libraries/manifest.js';
import { jobRunner } from '../runtime-libraries/job-runner.js';

export const runtimeLibrariesRouter = Router();

// GET /api/runtime-libraries — list installed libraries and current state
runtimeLibrariesRouter.get('/', asyncHandler(async (_req, res) => {
  ensureDirectories();
  const manifest = readManifest();
  const activeRelease = readActiveRelease();

  res.json({
    packages: manifest.packages,
    activeRelease,
    lastSuccessfulRelease: manifest.lastSuccessfulRelease,
    updatedAt: manifest.updatedAt,
    activeJob: jobRunner.getActiveJob(),
  });
}));

// POST /api/runtime-libraries/install — start an install job
runtimeLibrariesRouter.post('/install', asyncHandler(async (req, res) => {
  const { packages } = req.body as { packages?: Array<{ name: string; version: string }> };

  if (!packages || !Array.isArray(packages) || packages.length === 0) {
    throw badRequest('packages array is required and must not be empty');
  }

  for (const pkg of packages) {
    if (!pkg.name || typeof pkg.name !== 'string') {
      throw badRequest('Each package must have a name string');
    }
    if (!pkg.version || typeof pkg.version !== 'string') {
      throw badRequest('Each package must have a version string');
    }

    // Basic npm package name validation
    if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkg.name)) {
      throw badRequest(`Invalid package name: ${pkg.name}`);
    }
  }

  if (jobRunner.isRunning()) {
    const active = jobRunner.getActiveJob()!;
    throw conflict(`A job is already running (job ${active.id})`);
  }

  ensureDirectories();
  const job = jobRunner.startInstall(packages);

  res.status(202).json(job);
}));

// POST /api/runtime-libraries/remove — start a removal job
runtimeLibrariesRouter.post('/remove', asyncHandler(async (req, res) => {
  const { packages } = req.body as { packages?: string[] };

  if (!packages || !Array.isArray(packages) || packages.length === 0) {
    throw badRequest('packages array is required and must not be empty');
  }

  for (const name of packages) {
    if (!name || typeof name !== 'string') {
      throw badRequest('Each package must be a name string');
    }
  }

  if (jobRunner.isRunning()) {
    const active = jobRunner.getActiveJob()!;
    throw conflict(`A job is already running (job ${active.id})`);
  }

  ensureDirectories();
  const job = jobRunner.startRemove(packages);

  res.status(202).json(job);
}));

// GET /api/runtime-libraries/jobs/:jobId — get job status
runtimeLibrariesRouter.get('/jobs/:jobId', asyncHandler(async (req, res) => {
  const job = jobRunner.getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.json(job);
}));

// GET /api/runtime-libraries/jobs/:jobId/stream — SSE log stream
runtimeLibrariesRouter.get('/jobs/:jobId/stream', (req: Request, res: Response) => {
  const job = jobRunner.getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Prevent nginx buffering
  res.flushHeaders();

  // Send existing logs as catch-up
  for (const log of job.logs) {
    res.write(`data: ${JSON.stringify({ type: 'log', message: log })}\n\n`);
  }

  // Send current status
  res.write(`data: ${JSON.stringify({ type: 'status', status: job.status })}\n\n`);

  // If job is already finished, send done and close
  if (job.status === 'succeeded' || job.status === 'failed') {
    res.write(`data: ${JSON.stringify({ type: 'done', status: job.status, error: job.error })}\n\n`);
    res.end();
    return;
  }

  // Stream future events
  const onLog = (jobId: string, message: string) => {
    if (jobId !== req.params.jobId) return;
    res.write(`data: ${JSON.stringify({ type: 'log', message })}\n\n`);
  };

  const onStatus = (jobId: string, status: string) => {
    if (jobId !== req.params.jobId) return;
    res.write(`data: ${JSON.stringify({ type: 'status', status })}\n\n`);

    if (status === 'succeeded' || status === 'failed') {
      const finishedJob = jobRunner.getJob(jobId);
      res.write(`data: ${JSON.stringify({ type: 'done', status, error: finishedJob?.error })}\n\n`);
      cleanup();
      res.end();
    }
  };

  // Keepalive to prevent nginx timeout
  const keepalive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30_000);

  const cleanup = () => {
    clearInterval(keepalive);
    jobRunner.removeListener('log', onLog);
    jobRunner.removeListener('status', onStatus);
  };

  jobRunner.on('log', onLog);
  jobRunner.on('status', onStatus);

  req.on('close', cleanup);
});
