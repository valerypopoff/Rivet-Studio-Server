import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { conflict } from '../utils/httpError.js';
import { currentNodeModulesPath, ensureDirectories, readManifest } from '../runtime-libraries/manifest.js';
import { jobRunner, type JobStatus } from '../runtime-libraries/job-runner.js';

export const runtimeLibrariesRouter = Router();

const packageNamePattern = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const installSchema = z.object({
  packages: z.array(z.object({
    name: z.string().regex(packageNamePattern, 'Invalid package name'),
    version: z.string().min(1, 'Each package must have a version string'),
  })).min(1, 'packages array is required and must not be empty'),
});

const removeSchema = z.object({
  packages: z.array(z.string().min(1, 'Each package must be a name string')).min(1, 'packages array is required and must not be empty'),
});

runtimeLibrariesRouter.get('/', asyncHandler(async (_req, res) => {
  ensureDirectories();
  const manifest = readManifest();

  res.json({
    packages: manifest.packages,
    hasActiveLibraries: Boolean(currentNodeModulesPath()),
    updatedAt: manifest.updatedAt,
    activeJob: jobRunner.getActiveJob(),
  });
}));

runtimeLibrariesRouter.post('/install', validateBody(installSchema), asyncHandler(async (req, res) => {
  const { packages } = req.body as z.infer<typeof installSchema>;

  if (jobRunner.isRunning()) {
    const active = jobRunner.getActiveJob()!;
    throw conflict(`A job is already running (job ${active.id})`);
  }

  ensureDirectories();
  const job = jobRunner.startInstall(packages);
  res.status(202).json(job);
}));

runtimeLibrariesRouter.post('/remove', validateBody(removeSchema), asyncHandler(async (req, res) => {
  const { packages } = req.body as z.infer<typeof removeSchema>;

  if (jobRunner.isRunning()) {
    const active = jobRunner.getActiveJob()!;
    throw conflict(`A job is already running (job ${active.id})`);
  }

  ensureDirectories();
  const job = jobRunner.startRemove(packages);
  res.status(202).json(job);
}));

runtimeLibrariesRouter.get('/jobs/:jobId', asyncHandler(async (req, res) => {
  const job = jobRunner.getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.json(job);
}));

runtimeLibrariesRouter.get('/jobs/:jobId/stream', (req: Request, res: Response) => {
  const job = jobRunner.getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  for (const log of job.logs) {
    res.write(`data: ${JSON.stringify({ type: 'log', message: log })}\n\n`);
  }

  res.write(`data: ${JSON.stringify({ type: 'status', status: job.status })}\n\n`);

  if (job.status === 'succeeded' || job.status === 'failed') {
    res.write(`data: ${JSON.stringify({ type: 'done', status: job.status, error: job.error })}\n\n`);
    res.end();
    return;
  }

  const onLog = (jobId: string, message: string) => {
    if (jobId !== req.params.jobId) {
      return;
    }

    res.write(`data: ${JSON.stringify({ type: 'log', message })}\n\n`);
  };

  const onStatus = (jobId: string, status: JobStatus) => {
    if (jobId !== req.params.jobId) {
      return;
    }

    res.write(`data: ${JSON.stringify({ type: 'status', status })}\n\n`);

    if (status === 'succeeded' || status === 'failed') {
      const finishedJob = jobRunner.getJob(jobId);
      res.write(`data: ${JSON.stringify({ type: 'done', status, error: finishedJob?.error })}\n\n`);
      cleanup();
      res.end();
    }
  };

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
