import type { Pool } from 'pg';

import type { RuntimeLibraryJobLogEntry, RuntimeLibraryJobState } from '../../../../shared/runtime-library-types.js';
import {
  ACTIVE_JOB_STATUS_CLAUSE,
  mapJobRow,
  queryOne,
  queryRows,
  toIsoString,
  type RuntimeLibraryActivationRow,
  type RuntimeLibraryJobLogRow,
  type RuntimeLibraryJobRow,
} from './schema.js';

export async function getManagedJobLogs(pool: Pool, jobId: string): Promise<RuntimeLibraryJobLogEntry[]> {
  const rows = await queryRows<RuntimeLibraryJobLogRow>(
    pool,
    `
      SELECT seq, message, source, created_at
      FROM runtime_library_job_logs
      WHERE job_id = $1
      ORDER BY seq ASC
    `,
    [jobId],
  );

  return rows.map((row) => ({
    message: row.message,
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    source: row.source ?? 'system',
  }));
}

export async function getManagedJob(pool: Pool, jobId: string): Promise<RuntimeLibraryJobState | null> {
  const row = await queryOne<RuntimeLibraryJobRow>(
    pool,
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

  return mapJobRow(row, await getManagedJobLogs(pool, jobId));
}

export async function getManagedActiveJob(pool: Pool): Promise<RuntimeLibraryJobState | null> {
  const row = await queryOne<RuntimeLibraryJobRow>(
    pool,
    `
      SELECT job_id, type, status, packages_json, error, claimed_by, created_at, started_at, finished_at, progress_at, cancel_requested_at, release_id
      FROM runtime_library_jobs
      WHERE status IN ${ACTIVE_JOB_STATUS_CLAUSE}
      ORDER BY created_at ASC
      LIMIT 1
    `,
  );

  if (!row) {
    return null;
  }

  return mapJobRow(row, await getManagedJobLogs(pool, row.job_id));
}

export async function getManagedActiveRelease(pool: Pool): Promise<RuntimeLibraryActivationRow | null> {
  return queryOne<RuntimeLibraryActivationRow>(
    pool,
    `
      SELECT r.release_id, r.packages_json, r.artifact_blob_key, r.artifact_sha256, r.created_at, a.updated_at
      FROM runtime_library_activation a
      LEFT JOIN runtime_library_releases r ON r.release_id = a.active_release_id
      WHERE a.slot = 'default'
    `,
  );
}
