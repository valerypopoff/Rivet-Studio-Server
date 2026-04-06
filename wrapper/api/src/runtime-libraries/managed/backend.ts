import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';

import { Pool } from 'pg';
import type { Request, Response } from 'express';

import type {
  JobStatus,
  RuntimeLibraryReplicaCleanupResult,
  RuntimeLibraryJobState,
  RuntimeLibraryLogSource,
  RuntimeLibraryPackageSpec,
} from '../../../../shared/runtime-library-types.js';
import type { RuntimeLibrariesBackend } from '../backend.js';
import { getManagedRuntimeLibrariesConfig } from '../config.js';
import { ensureDirectories } from '../manifest.js';
import { conflict, createHttpError } from '../../utils/httpError.js';
import {
  S3RuntimeLibrariesBlobStore,
  createRuntimeLibraryReleaseArtifactKey,
  type RuntimeLibrariesBlobStore,
} from './blob-store.js';
import { ManagedRuntimeLibrariesLocalCache } from './local-cache.js';
import {
  ACTIVE_JOB_STATUS_CLAUSE,
  getRuntimeLibraryReplicaHeartbeatTtlMs,
  getPoolConfig,
  isUniqueViolation,
  JobCancelledError,
  JOB_HEARTBEAT_INTERVAL_MS,
  MANAGED_RUNTIME_LIBRARIES_SCHEMA_SQL,
  mapJobRow,
  PROCESS_TERMINATE_GRACE_MS,
  queryOne,
  queryRows,
  STALE_JOB_TIMEOUT_MS,
  type RuntimeLibraryJobRow,
} from './schema.js';
import {
  getManagedActiveJob,
  getManagedActiveRelease,
  getManagedJob,
  getManagedRuntimeLibrariesState,
} from './state.js';
import { buildCandidatePackages, buildReleaseArtifact } from './release-builder.js';
import { normalizeJobPackages, normalizePackageMap, wait } from './schema.js';

export class ManagedRuntimeLibrariesBackend implements RuntimeLibrariesBackend {
  readonly #config = getManagedRuntimeLibrariesConfig();
  readonly #pool = new Pool(getPoolConfig(this.#config));
  readonly #blobStore: RuntimeLibrariesBlobStore;
  readonly #instanceId = `${os.hostname()}-${process.pid}-${randomUUID()}`;
  readonly #localCache: ManagedRuntimeLibrariesLocalCache;

  #initializePromise: Promise<void> | null = null;
  #workerStarted = false;
  #stopped = false;
  #runningProcesses = new Map<string, ChildProcess>();

  #getProcessManagedSync() {
    return (globalThis as {
      __RIVET_PREPARE_RUNTIME_LIBRARIES__?: (force?: boolean) => Promise<void>;
    }).__RIVET_PREPARE_RUNTIME_LIBRARIES__;
  }

  async #syncForLocalUse(force: boolean): Promise<void> {
    const globalPrepare = this.#getProcessManagedSync();

    if (globalPrepare) {
      await globalPrepare(force);
      return;
    }

    await this.#localCache.sync(force);
  }

  constructor(blobStore?: RuntimeLibrariesBlobStore) {
    this.#blobStore = blobStore ?? new S3RuntimeLibrariesBlobStore(this.#config);
    this.#localCache = new ManagedRuntimeLibrariesLocalCache(this.#pool, this.#blobStore, this.#config);
  }

  async initialize(): Promise<void> {
    if (this.#initializePromise) {
      return this.#initializePromise;
    }

    this.#stopped = false;
    this.#initializePromise = (async () => {
      ensureDirectories();
      fs.mkdirSync(this.#localCache.jobsRoot(), { recursive: true });
      await this.#blobStore.initialize?.();
      await this.#pool.query(MANAGED_RUNTIME_LIBRARIES_SCHEMA_SQL);
      await this.#syncForLocalUse(true);
      this.#startWorkerLoop();
    })();

    try {
      await this.#initializePromise;
    } catch (error) {
      this.#initializePromise = null;
      throw error;
    }
  }

  async prepareForExecution(): Promise<void> {
    await this.initialize();
    await this.#syncForLocalUse(true);
  }

  async dispose(): Promise<void> {
    this.#stopped = true;
    this.#workerStarted = false;
    this.#initializePromise = null;
    this.#localCache.reset();
    for (const [jobId] of this.#runningProcesses) {
      this.#terminateRunningProcess(jobId, 'Runtime-library backend is shutting down.');
    }
    this.#runningProcesses.clear();
    await this.#pool.end();
  }

  async getState() {
    await this.initialize();
    return getManagedRuntimeLibrariesState(this.#pool, this.#config.syncPollIntervalMs);
  }

  async enqueueInstall(packages: RuntimeLibraryPackageSpec[]): Promise<RuntimeLibraryJobState> {
    await this.initialize();
    const normalizedPackages = normalizeJobPackages(packages);
    if (normalizedPackages.length === 0) {
      throw createHttpError(400, 'packages array is required and must not be empty');
    }

    return this.#insertJob('install', normalizedPackages);
  }

  async enqueueRemove(packageNames: string[]): Promise<RuntimeLibraryJobState> {
    await this.initialize();
    const normalizedPackages = normalizeJobPackages(packageNames.map((name) => ({ name, version: '' })));
    if (normalizedPackages.length === 0) {
      throw createHttpError(400, 'packages array is required and must not be empty');
    }

    return this.#insertJob('remove', normalizedPackages);
  }

  async getJob(jobId: string): Promise<RuntimeLibraryJobState | null> {
    await this.initialize();
    return getManagedJob(this.#pool, jobId);
  }

  async cancelJob(jobId: string): Promise<RuntimeLibraryJobState | null> {
    await this.initialize();
    const row = await queryOne<RuntimeLibraryJobRow>(
      this.#pool,
      `
        SELECT job_id, type, status, packages_json, error, claimed_by, created_at, started_at, finished_at, progress_at, cancel_requested_at, release_id
        FROM runtime_library_jobs
        WHERE job_id = $1
      `,
      [jobId],
    );
    if (!row) {
      return null;
    }

    if (row.status === 'succeeded' || row.status === 'failed' || row.cancel_requested_at) {
      return this.getJob(jobId);
    }

    await this.#pool.query(
      `
        UPDATE runtime_library_jobs
        SET cancel_requested_at = NOW(),
            progress_at = NOW(),
            updated_at = NOW()
        WHERE job_id = $1
      `,
      [jobId],
    );
    await this.#appendJobLog(jobId, 'Cancellation requested by user.', 'system');

    if (row.status === 'queued') {
      await this.#failJob(jobId, new JobCancelledError());
      return this.getJob(jobId);
    }

    if (row.claimed_by === this.#instanceId) {
      this.#terminateRunningProcess(jobId, 'Cancellation requested by user.');
    }

    return this.getJob(jobId);
  }

  async clearStaleReplicaStatuses(): Promise<RuntimeLibraryReplicaCleanupResult> {
    await this.initialize();
    const heartbeatTtlMs = getRuntimeLibraryReplicaHeartbeatTtlMs(this.#config.syncPollIntervalMs);
    const staleBefore = new Date(Date.now() - heartbeatTtlMs).toISOString();
    const rows = await queryRows<{ replica_id: string }>(
      this.#pool,
      `
        DELETE FROM runtime_library_replica_status
        WHERE last_heartbeat_at < NOW() - ($1 * INTERVAL '1 millisecond')
        RETURNING replica_id
      `,
      [heartbeatTtlMs],
    );

    return {
      deletedReplicaCount: rows.length,
      deletedReplicaIds: rows.map((row) => row.replica_id),
      staleBefore,
    };
  }

  async streamJob(req: Request, res: Response): Promise<void> {
    await this.initialize();
    let previousStatus: JobStatus | null = null;
    let lastSeq = 0;
    let closed = false;

    const sendState = async () => {
      const job = await this.getJob(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return false;
      }

      for (const [index, entry] of job.logEntries.entries()) {
        const seq = index + 1;
        if (seq <= lastSeq) {
          continue;
        }

        lastSeq = seq;
        res.write(`data: ${JSON.stringify({ type: 'log', message: entry.message, createdAt: entry.createdAt, source: entry.source })}\n\n`);
      }

      if (job.status !== previousStatus) {
        previousStatus = job.status;
        res.write(`data: ${JSON.stringify({ type: 'status', status: job.status, createdAt: job.lastProgressAt, cancelRequestedAt: job.cancelRequestedAt ?? null })}\n\n`);
      }

      if (job.status === 'succeeded' || job.status === 'failed') {
        res.write(`data: ${JSON.stringify({ type: 'done', status: job.status, error: job.error, createdAt: job.lastProgressAt, cancelRequestedAt: job.cancelRequestedAt ?? null })}\n\n`);
        return false;
      }

      return true;
    };

    const initialJob = await this.getJob(req.params.jobId);
    if (!initialJob) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    lastSeq = initialJob.logEntries.length;
    for (const entry of initialJob.logEntries) {
      res.write(`data: ${JSON.stringify({ type: 'log', message: entry.message, createdAt: entry.createdAt, source: entry.source })}\n\n`);
    }
    previousStatus = initialJob.status;
    res.write(`data: ${JSON.stringify({ type: 'status', status: initialJob.status, createdAt: initialJob.lastProgressAt, cancelRequestedAt: initialJob.cancelRequestedAt ?? null })}\n\n`);

    if (initialJob.status === 'succeeded' || initialJob.status === 'failed') {
      res.write(`data: ${JSON.stringify({ type: 'done', status: initialJob.status, error: initialJob.error, createdAt: initialJob.lastProgressAt, cancelRequestedAt: initialJob.cancelRequestedAt ?? null })}\n\n`);
      res.end();
      return;
    }

    const interval = setInterval(() => {
      if (closed) {
        return;
      }

      void sendState()
        .then((keepOpen) => {
          if (!keepOpen && !closed) {
            cleanup();
            res.end();
          }
        })
        .catch((error) => {
          console.error('[runtime-libraries] Failed to poll managed job stream:', error);
          cleanup();
          res.end();
        });
    }, 1_000);

    const keepalive = setInterval(() => {
      if (!closed) {
        res.write(':keepalive\n\n');
      }
    }, 30_000);

    const cleanup = () => {
      closed = true;
      clearInterval(interval);
      clearInterval(keepalive);
    };

    req.on('close', cleanup);
  }

  async #insertJob(type: 'install' | 'remove', packages: RuntimeLibraryPackageSpec[]): Promise<RuntimeLibraryJobState> {
    const jobId = randomUUID();
    try {
      const row = await queryOne<RuntimeLibraryJobRow>(
        this.#pool,
        `
          INSERT INTO runtime_library_jobs(job_id, type, status, packages_json)
          VALUES ($1, $2, 'queued', $3::jsonb)
          RETURNING job_id, type, status, packages_json, error, claimed_by, created_at, started_at, finished_at, progress_at, cancel_requested_at, release_id
        `,
        [jobId, type, JSON.stringify(packages)],
      );

      if (!row) {
        throw new Error('Failed to create runtime-library job');
      }

      return mapJobRow(row, []);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const active = await getManagedActiveJob(this.#pool);
        if (active) {
          throw conflict(`A job is already running (job ${active.id})`);
        }

        throw conflict('A job is already running');
      }

      throw error;
    }
  }

  #startWorkerLoop(): void {
    if (this.#workerStarted) {
      return;
    }

    this.#workerStarted = true;
    void this.#workerLoop();
  }

  async #workerLoop(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.#recoverStaleJobs();
        if (!this.#getProcessManagedSync()) {
          await this.#syncForLocalUse(false);
        }
        const job = await this.#claimNextJob();
        if (!job) {
          await wait(1_000);
          continue;
        }

        await this.#processJob(job);
      } catch (error) {
        if (this.#stopped) {
          break;
        }

        console.error('[runtime-libraries] Managed worker loop failed:', error);
        await wait(2_000);
      }
    }
  }

  async #claimNextJob(): Promise<RuntimeLibraryJobRow | null> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const row = await queryOne<RuntimeLibraryJobRow>(
        client,
        `
          WITH next_job AS (
            SELECT job_id
            FROM runtime_library_jobs
            WHERE status = 'queued'
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE runtime_library_jobs AS job
          SET status = 'running',
              started_at = COALESCE(started_at, NOW()),
              claimed_by = $1,
              updated_at = NOW()
          FROM next_job
          WHERE job.job_id = next_job.job_id
          RETURNING job.job_id, job.type, job.status, job.packages_json, job.error, job.claimed_by, job.created_at, job.started_at, job.finished_at, job.progress_at, job.cancel_requested_at, job.release_id
        `,
        [this.#instanceId],
      );
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async #processJob(job: RuntimeLibraryJobRow): Promise<void> {
    await this.#withJobHeartbeat(job.job_id, async () => {
      await this.#appendJobLog(job.job_id, `--- Starting ${job.type} job ---`);
      const candidatePackages = await buildCandidatePackages(
        job,
        async () => {
          const activeRelease = await getManagedActiveRelease(this.#pool);
          return activeRelease ? normalizePackageMap(activeRelease.packages_json) : {};
        },
        this.#appendJobLog.bind(this),
        normalizeJobPackages,
      );
      await this.#throwIfCancellationRequested(job.job_id);

      const buildResult = await buildReleaseArtifact({
        job,
        candidatePackages,
        jobsRoot: this.#localCache.jobsRoot(),
        appendJobLog: this.#appendJobLog.bind(this),
        throwIfCancellationRequested: this.#throwIfCancellationRequested.bind(this),
        updateJobStatus: async (jobId, status) => this.#updateJobStatus(jobId, status),
        registerRunningProcess: (jobId, process) => {
          if (process) {
            this.#runningProcesses.set(jobId, process);
            return;
          }

          this.#runningProcesses.delete(jobId);
        },
        terminateRunningProcess: this.#terminateRunningProcess.bind(this),
        isCancellationRequested: this.#isCancellationRequested.bind(this),
      });

      await this.#updateJobStatus(job.job_id, 'activating');
      await this.#appendJobLog(job.job_id, 'Uploading release artifact...');
      const releaseId = randomUUID();
      const artifactBlobKey = createRuntimeLibraryReleaseArtifactKey(releaseId);

      try {
        await this.#throwIfCancellationRequested(job.job_id);
        await this.#blobStore.putBuffer(artifactBlobKey, buildResult.archiveBuffer, 'application/x-tar');
        await this.#throwIfCancellationRequested(job.job_id);
      } catch (error) {
        if (!(error instanceof JobCancelledError)) {
          await this.#failJob(job.job_id, error);
          return;
        }

        await this.#blobStore.delete(artifactBlobKey).catch(() => {});
        await this.#failJob(job.job_id, error);
        return;
      }

      try {
        const client = await this.#pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `
              INSERT INTO runtime_library_releases(release_id, packages_json, artifact_blob_key, artifact_sha256)
              VALUES ($1, $2::jsonb, $3, $4)
            `,
            [releaseId, JSON.stringify(candidatePackages), artifactBlobKey, buildResult.archiveSha256],
          );
          await client.query(
            `
              UPDATE runtime_library_activation
              SET active_release_id = $1,
                  updated_at = NOW()
              WHERE slot = 'default'
            `,
            [releaseId],
          );
          await client.query(
            `
              UPDATE runtime_library_jobs
              SET status = 'succeeded',
                  release_id = $2,
                  error = NULL,
                  claimed_by = NULL,
                  cancel_requested_at = NULL,
                  finished_at = NOW(),
                  progress_at = NOW(),
                  updated_at = NOW()
              WHERE job_id = $1
            `,
            [job.job_id, releaseId],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        await this.#blobStore.delete(artifactBlobKey).catch(() => {});
        await this.#failJob(job.job_id, error);
        return;
      }

      await this.#appendJobLog(job.job_id, `Activated release ${releaseId}.`).catch((error) => {
        console.error('[runtime-libraries] Failed to append managed activation log:', error);
      });
      await this.#appendJobLog(job.job_id, '--- Job completed successfully ---').catch((error) => {
        console.error('[runtime-libraries] Failed to append managed completion log:', error);
      });

      this.#localCache.reset();
      await this.#syncForLocalUse(true).catch((error) => {
        console.error('[runtime-libraries] Managed release activated but local API cache sync failed:', error);
      });
    }).catch(async (error) => {
      await this.#failJob(job.job_id, error);
    });
  }

  async #appendJobLog(jobId: string, message: string, source: RuntimeLibraryLogSource = 'system'): Promise<void> {
    await this.#pool.query(
      `
        WITH inserted AS (
          INSERT INTO runtime_library_job_logs(job_id, message, source)
          VALUES ($1, $2, $3)
          RETURNING job_id
        )
        UPDATE runtime_library_jobs
        SET progress_at = NOW(),
            updated_at = NOW()
        WHERE job_id = $1
      `,
      [jobId, message, source],
    );
  }

  async #updateJobStatus(jobId: string, status: JobStatus): Promise<void> {
    await this.#pool.query(
      `
        UPDATE runtime_library_jobs
        SET status = $2,
            progress_at = NOW(),
            updated_at = NOW()
        WHERE job_id = $1
      `,
      [jobId, status],
    );
  }

  async #failJob(jobId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.#terminateRunningProcess(jobId, message);
    await this.#appendJobLog(jobId, `ERROR: ${message}`);
    await this.#appendJobLog(jobId, '--- Job failed ---');
    await this.#pool.query(
      `
        UPDATE runtime_library_jobs
        SET status = 'failed',
            error = $2,
            claimed_by = NULL,
            finished_at = NOW(),
            progress_at = NOW(),
            updated_at = NOW()
        WHERE job_id = $1
      `,
      [jobId, message],
    );
  }

  async #touchJob(jobId: string): Promise<void> {
    if (this.#stopped) {
      return;
    }

    await this.#pool.query(
      `
        UPDATE runtime_library_jobs
        SET updated_at = NOW()
        WHERE job_id = $1
          AND status IN ${ACTIVE_JOB_STATUS_CLAUSE}
      `,
      [jobId],
    );
  }

  async #withJobHeartbeat<T>(jobId: string, run: () => Promise<T>): Promise<T> {
    const heartbeat = setInterval(() => {
      void this.#touchJob(jobId).catch((error) => {
        console.error('[runtime-libraries] Managed job heartbeat failed:', error);
      });
    }, JOB_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    try {
      return await run();
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #recoverStaleJobs(): Promise<void> {
    const rows = await queryRows<{ job_id: string }>(
      this.#pool,
      `
        UPDATE runtime_library_jobs
        SET status = 'failed',
            error = COALESCE(error, 'Job heartbeat timed out; worker was assumed dead'),
            claimed_by = NULL,
            finished_at = COALESCE(finished_at, NOW()),
            progress_at = NOW(),
            updated_at = NOW()
        WHERE status IN ${ACTIVE_JOB_STATUS_CLAUSE}
          AND updated_at < NOW() - ($1 * INTERVAL '1 millisecond')
        RETURNING job_id
      `,
      [STALE_JOB_TIMEOUT_MS],
    );

    for (const row of rows) {
      await this.#appendJobLog(row.job_id, 'ERROR: Job heartbeat timed out; marking job as failed.').catch(() => {});
      await this.#appendJobLog(row.job_id, '--- Job failed ---').catch(() => {});
    }
  }

  async #isCancellationRequested(jobId: string): Promise<boolean> {
    const row = await queryOne<{ cancel_requested_at: Date | string | null }>(
      this.#pool,
      'SELECT cancel_requested_at FROM runtime_library_jobs WHERE job_id = $1',
      [jobId],
    );
    return Boolean(row?.cancel_requested_at);
  }

  async #throwIfCancellationRequested(jobId: string): Promise<void> {
    if (await this.#isCancellationRequested(jobId)) {
      throw new JobCancelledError();
    }
  }

  #terminateRunningProcess(jobId: string, reason: string): void {
    const process = this.#runningProcesses.get(jobId);
    if (!process || process.killed) {
      this.#runningProcesses.delete(jobId);
      return;
    }

    try {
      process.kill('SIGTERM');
    } catch {
      this.#runningProcesses.delete(jobId);
      return;
    }

    const killTimer = setTimeout(() => {
      const stillRunning = this.#runningProcesses.get(jobId) === process && process.exitCode == null;
      if (!stillRunning) {
        return;
      }

      void this.#appendJobLog(jobId, `Process did not exit after SIGTERM (${reason}); forcing shutdown.`, 'system').catch(() => {});
      try {
        process.kill('SIGKILL');
      } catch {
        // ignore late kill failures
      }
    }, PROCESS_TERMINATE_GRACE_MS);
    killTimer.unref?.();

    process.once('exit', () => {
      clearTimeout(killTimer);
      if (this.#runningProcesses.get(jobId) === process) {
        this.#runningProcesses.delete(jobId);
      }
    });
  }
}
