import assert from 'node:assert/strict';
import test from 'node:test';

const cleanup = await import('../runtime-libraries/managed/cleanup.js');
const runtimeLibrariesConfig = await import('../runtime-libraries/config.js');
const bootstrapConfig = await import(new URL('../../../../ops/proxy-bootstrap/config.mjs', import.meta.url).href) as {
  isManagedRuntimeLibrariesEnabled: () => boolean;
  getManagedRuntimeLibrariesConfig: () => Record<string, unknown>;
};

const managedEnvKeys = [
  'RIVET_STORAGE_MODE',
  'RIVET_DATABASE_MODE',
  'RIVET_DATABASE_CONNECTION_STRING',
  'RIVET_DATABASE_SSL_MODE',
  'RIVET_STORAGE_URL',
  'RIVET_STORAGE_BUCKET',
  'RIVET_STORAGE_REGION',
  'RIVET_STORAGE_ENDPOINT',
  'RIVET_STORAGE_ACCESS_KEY_ID',
  'RIVET_STORAGE_ACCESS_KEY',
  'RIVET_STORAGE_PREFIX',
  'RIVET_STORAGE_FORCE_PATH_STYLE',
  'RIVET_STORAGE_BACKEND',
  'RIVET_WORKFLOWS_STORAGE_BACKEND',
  'RIVET_DATABASE_URL',
  'RIVET_WORKFLOWS_DATABASE_MODE',
  'RIVET_WORKFLOWS_DATABASE_URL',
  'RIVET_WORKFLOWS_DATABASE_CONNECTION_STRING',
  'RIVET_WORKFLOWS_DATABASE_SSL_MODE',
  'RIVET_OBJECT_STORAGE_BUCKET',
  'RIVET_OBJECT_STORAGE_REGION',
  'RIVET_OBJECT_STORAGE_ENDPOINT',
  'RIVET_OBJECT_STORAGE_ACCESS_KEY_ID',
  'RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_URL',
  'RIVET_WORKFLOWS_STORAGE_BUCKET',
  'RIVET_WORKFLOWS_STORAGE_REGION',
  'RIVET_WORKFLOWS_STORAGE_ENDPOINT',
  'RIVET_WORKFLOWS_STORAGE_ACCESS_KEY_ID',
  'RIVET_WORKFLOWS_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_FORCE_PATH_STYLE',
  'RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS',
  'RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS',
] as const;

async function withManagedEnv(
  overrides: Partial<Record<(typeof managedEnvKeys)[number], string | undefined>>,
  run: () => Promise<void> | void,
) {
  const previous = new Map<string, string | undefined>();

  for (const key of managedEnvKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value != null) {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const key of managedEnvKeys) {
      const value = previous.get(key);
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function isoDaysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function isoHoursBefore(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1_000).toISOString();
}

test('API and bootstrap runtime-library config stay in parity for storage URL form', async () => {
  await withManagedEnv({
    RIVET_STORAGE_MODE: 'managed',
    RIVET_DATABASE_MODE: 'managed',
    RIVET_DATABASE_CONNECTION_STRING: 'postgresql://db-user:db-pass@example-db:25060/defaultdb?sslmode=disable',
    RIVET_STORAGE_URL: 'https://test-bucket-111.sfo3.digitaloceanspaces.com',
    RIVET_STORAGE_ACCESS_KEY_ID: 'spaces-access-key-id',
    RIVET_STORAGE_ACCESS_KEY: 'spaces-secret-access-key',
    RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS: '7000',
  }, () => {
    assert.equal(runtimeLibrariesConfig.getRuntimeLibrariesBackendMode(), 'managed');
    assert.equal(bootstrapConfig.isManagedRuntimeLibrariesEnabled(), true);
    assert.deepEqual(
      bootstrapConfig.getManagedRuntimeLibrariesConfig(),
      runtimeLibrariesConfig.getManagedRuntimeLibrariesConfig(),
    );
  });
});

test('API and bootstrap runtime-library config stay in parity for explicit S3 tuple form', async () => {
  await withManagedEnv({
    RIVET_STORAGE_MODE: 'managed',
    RIVET_DATABASE_MODE: 'local-docker',
    RIVET_DATABASE_CONNECTION_STRING: 'postgres://rivet:rivet@workflow-postgres:5432/rivet?sslmode=require',
    RIVET_DATABASE_SSL_MODE: 'disable',
    RIVET_STORAGE_BUCKET: 'rivet-artifacts',
    RIVET_STORAGE_REGION: 'us-east-1',
    RIVET_STORAGE_ENDPOINT: 'http://workflow-minio:9000',
    RIVET_STORAGE_ACCESS_KEY_ID: 'minioadmin',
    RIVET_STORAGE_ACCESS_KEY: 'minioadmin',
    RIVET_STORAGE_FORCE_PATH_STYLE: 'true',
    RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS: '5000',
  }, () => {
    assert.deepEqual(
      bootstrapConfig.getManagedRuntimeLibrariesConfig(),
      runtimeLibrariesConfig.getManagedRuntimeLibrariesConfig(),
    );
  });
});

test('managed runtime-library audit reports integrity issues and prune candidates correctly', () => {
  const now = new Date('2026-04-05T12:00:00.000Z');
  const snapshot = cleanup.buildManagedRuntimeLibrariesAuditSnapshotFromState({
    activeReleaseId: 'release-active',
    releases: [
      { release_id: 'release-active', packages_json: {}, artifact_blob_key: 'releases/release-active/release.tar', artifact_sha256: 'sha-active', created_at: isoDaysBefore(now, 1) },
      { release_id: 'release-2d', packages_json: {}, artifact_blob_key: 'releases/release-2d/release.tar', artifact_sha256: 'sha-2d', created_at: isoDaysBefore(now, 2) },
      { release_id: 'release-10d', packages_json: {}, artifact_blob_key: 'releases/release-10d/release.tar', artifact_sha256: 'sha-10d', created_at: isoDaysBefore(now, 10) },
      { release_id: 'release-20d', packages_json: {}, artifact_blob_key: 'releases/release-20d/release.tar', artifact_sha256: 'sha-20d', created_at: isoDaysBefore(now, 20) },
      { release_id: 'release-30d', packages_json: {}, artifact_blob_key: 'releases/release-30d/release.tar', artifact_sha256: 'sha-30d', created_at: isoDaysBefore(now, 30) },
      { release_id: 'release-40d', packages_json: {}, artifact_blob_key: 'releases/release-40d/release.tar', artifact_sha256: 'sha-40d', created_at: isoDaysBefore(now, 40) },
      { release_id: 'release-missing', packages_json: {}, artifact_blob_key: 'releases/release-missing/release.tar', artifact_sha256: 'sha-missing', created_at: isoDaysBefore(now, 50) },
      { release_id: 'release-inflight', packages_json: {}, artifact_blob_key: 'releases/release-inflight/release.tar', artifact_sha256: 'sha-inflight', created_at: isoDaysBefore(now, 90) },
      { release_id: 'release-prune', packages_json: {}, artifact_blob_key: 'releases/release-prune/release.tar', artifact_sha256: 'sha-prune', created_at: isoDaysBefore(now, 120) },
    ],
    jobs: [
      {
        job_id: 'job-running',
        type: 'install',
        status: 'running',
        packages_json: [],
        error: null,
        claimed_by: 'worker-1',
        created_at: isoDaysBefore(now, 1),
        started_at: isoDaysBefore(now, 1),
        finished_at: null,
        progress_at: isoDaysBefore(now, 0.1),
        cancel_requested_at: null,
        release_id: 'release-inflight',
      },
      {
        job_id: 'job-succeeded-recent',
        type: 'install',
        status: 'succeeded',
        packages_json: [],
        error: null,
        claimed_by: null,
        created_at: isoDaysBefore(now, 3),
        started_at: isoDaysBefore(now, 3),
        finished_at: isoDaysBefore(now, 3),
        progress_at: isoDaysBefore(now, 3),
        cancel_requested_at: null,
        release_id: 'release-10d',
      },
      {
        job_id: 'job-succeeded-old',
        type: 'remove',
        status: 'succeeded',
        packages_json: [],
        error: null,
        claimed_by: null,
        created_at: isoDaysBefore(now, 40),
        started_at: isoDaysBefore(now, 40),
        finished_at: isoDaysBefore(now, 40),
        progress_at: isoDaysBefore(now, 40),
        cancel_requested_at: null,
        release_id: 'release-40d',
      },
      {
        job_id: 'job-failed-recent',
        type: 'install',
        status: 'failed',
        packages_json: [],
        error: 'boom',
        claimed_by: null,
        created_at: isoDaysBefore(now, 5),
        started_at: isoDaysBefore(now, 5),
        finished_at: isoDaysBefore(now, 5),
        progress_at: isoDaysBefore(now, 5),
        cancel_requested_at: null,
        release_id: null,
      },
      {
        job_id: 'job-failed-old',
        type: 'install',
        status: 'failed',
        packages_json: [],
        error: 'boom',
        claimed_by: null,
        created_at: isoDaysBefore(now, 20),
        started_at: isoDaysBefore(now, 20),
        finished_at: isoDaysBefore(now, 20),
        progress_at: isoDaysBefore(now, 20),
        cancel_requested_at: null,
        release_id: null,
      },
    ],
    objects: [
      { key: 'releases/release-active/release.tar', size: 10, lastModified: isoDaysBefore(now, 1) },
      { key: 'releases/release-2d/release.tar', size: 10, lastModified: isoDaysBefore(now, 2) },
      { key: 'releases/release-10d/release.tar', size: 10, lastModified: isoDaysBefore(now, 10) },
      { key: 'releases/release-20d/release.tar', size: 10, lastModified: isoDaysBefore(now, 20) },
      { key: 'releases/release-30d/release.tar', size: 10, lastModified: isoDaysBefore(now, 30) },
      { key: 'releases/release-40d/release.tar', size: 10, lastModified: isoDaysBefore(now, 40) },
      { key: 'releases/release-inflight/release.tar', size: 10, lastModified: isoDaysBefore(now, 90) },
      { key: 'releases/release-prune/release.tar', size: 10, lastModified: isoDaysBefore(now, 120) },
      { key: 'orphaned/old.tar', size: 7, lastModified: isoDaysBefore(now, 3) },
      { key: 'orphaned/new.tar', size: 7, lastModified: isoHoursBefore(now, 1) },
    ],
  }, now);

  assert.equal(snapshot.activeReleaseId, 'release-active');
  assert.deepEqual(snapshot.releaseRowsMissingArtifacts.map((entry) => entry.releaseId), ['release-missing']);
  assert.deepEqual(snapshot.orphanedArtifacts.map((entry) => entry.key), ['orphaned/new.tar', 'orphaned/old.tar']);
  assert.deepEqual(snapshot.releasesReferencedByInFlightJobs, ['release-inflight']);
  assert.deepEqual(snapshot.prunePlan.pruneCandidateReleaseIds, ['release-prune']);
  assert.deepEqual(snapshot.prunePlan.pruneCandidateJobIds.sort(), ['job-failed-old', 'job-succeeded-old']);
  assert.deepEqual(snapshot.prunePlan.pruneCandidateOrphanedArtifactKeys, ['orphaned/old.tar']);
});

test('managed runtime-library prune dry run does not delete anything', async () => {
  const before = cleanup.buildManagedRuntimeLibrariesAuditSnapshotFromState({
    activeReleaseId: 'release-active',
    releases: [
      { release_id: 'release-active', packages_json: {}, artifact_blob_key: 'releases/release-active/release.tar', artifact_sha256: 'sha-active', created_at: '2026-04-04T00:00:00.000Z' },
      { release_id: 'release-prune', packages_json: {}, artifact_blob_key: 'releases/release-prune/release.tar', artifact_sha256: 'sha-prune', created_at: '2025-12-01T00:00:00.000Z' },
    ],
    jobs: [],
    objects: [
      { key: 'releases/release-active/release.tar', size: 1, lastModified: '2026-04-04T00:00:00.000Z' },
      { key: 'releases/release-prune/release.tar', size: 1, lastModified: '2025-12-01T00:00:00.000Z' },
    ],
  }, new Date('2026-04-05T12:00:00.000Z'));

  const deletes = { jobs: 0, releases: 0, objects: 0 };
  const result = await cleanup.pruneManagedRuntimeLibrariesState({
    apply: false,
    driver: {
      audit: async () => before,
      deleteJobs: async () => {
        deletes.jobs += 1;
        return 0;
      },
      deleteReleases: async () => {
        deletes.releases += 1;
        return 0;
      },
      deleteObjects: async () => {
        deletes.objects += 1;
        return 0;
      },
    },
  });

  assert.equal(result.deletedJobCount, 0);
  assert.equal(result.deletedReleaseCount, 0);
  assert.equal(result.deletedObjectCount, 0);
  assert.deepEqual(result.before, before);
  assert.deepEqual(result.after, before);
  assert.deepEqual(deletes, { jobs: 0, releases: 0, objects: 0 });
});

test('managed runtime-library prune apply deletes only plan candidates', async () => {
  const before = cleanup.buildManagedRuntimeLibrariesAuditSnapshotFromState({
    activeReleaseId: 'release-active',
    releases: [
      { release_id: 'release-active', packages_json: {}, artifact_blob_key: 'releases/release-active/release.tar', artifact_sha256: 'sha-active', created_at: '2026-04-04T00:00:00.000Z' },
      { release_id: 'release-2d', packages_json: {}, artifact_blob_key: 'releases/release-2d/release.tar', artifact_sha256: 'sha-2d', created_at: '2026-04-03T00:00:00.000Z' },
      { release_id: 'release-10d', packages_json: {}, artifact_blob_key: 'releases/release-10d/release.tar', artifact_sha256: 'sha-10d', created_at: '2026-03-26T00:00:00.000Z' },
      { release_id: 'release-20d', packages_json: {}, artifact_blob_key: 'releases/release-20d/release.tar', artifact_sha256: 'sha-20d', created_at: '2026-03-16T00:00:00.000Z' },
      { release_id: 'release-30d', packages_json: {}, artifact_blob_key: 'releases/release-30d/release.tar', artifact_sha256: 'sha-30d', created_at: '2026-03-06T00:00:00.000Z' },
      { release_id: 'release-40d', packages_json: {}, artifact_blob_key: 'releases/release-40d/release.tar', artifact_sha256: 'sha-40d', created_at: '2026-02-24T00:00:00.000Z' },
      { release_id: 'release-prune', packages_json: {}, artifact_blob_key: 'releases/release-prune/release.tar', artifact_sha256: 'sha-prune', created_at: '2025-12-01T00:00:00.000Z' },
    ],
    jobs: [
      {
        job_id: 'job-prune',
        type: 'remove',
        status: 'failed',
        packages_json: [],
        error: 'boom',
        claimed_by: null,
        created_at: '2026-03-01T00:00:00.000Z',
        started_at: '2026-03-01T00:00:00.000Z',
        finished_at: '2026-03-01T00:00:00.000Z',
        progress_at: '2026-03-01T00:00:00.000Z',
        cancel_requested_at: null,
        release_id: null,
      },
    ],
    objects: [
      { key: 'releases/release-active/release.tar', size: 1, lastModified: '2026-04-04T00:00:00.000Z' },
      { key: 'releases/release-2d/release.tar', size: 1, lastModified: '2026-04-03T00:00:00.000Z' },
      { key: 'releases/release-10d/release.tar', size: 1, lastModified: '2026-03-26T00:00:00.000Z' },
      { key: 'releases/release-20d/release.tar', size: 1, lastModified: '2026-03-16T00:00:00.000Z' },
      { key: 'releases/release-30d/release.tar', size: 1, lastModified: '2026-03-06T00:00:00.000Z' },
      { key: 'releases/release-40d/release.tar', size: 1, lastModified: '2026-02-24T00:00:00.000Z' },
      { key: 'releases/release-prune/release.tar', size: 1, lastModified: '2025-12-01T00:00:00.000Z' },
      { key: 'orphaned/old.tar', size: 1, lastModified: '2026-03-01T00:00:00.000Z' },
    ],
  }, new Date('2026-04-05T12:00:00.000Z'));

  const after = cleanup.buildManagedRuntimeLibrariesAuditSnapshotFromState({
    activeReleaseId: 'release-active',
    releases: [
      { release_id: 'release-active', packages_json: {}, artifact_blob_key: 'releases/release-active/release.tar', artifact_sha256: 'sha-active', created_at: '2026-04-04T00:00:00.000Z' },
      { release_id: 'release-2d', packages_json: {}, artifact_blob_key: 'releases/release-2d/release.tar', artifact_sha256: 'sha-2d', created_at: '2026-04-03T00:00:00.000Z' },
      { release_id: 'release-10d', packages_json: {}, artifact_blob_key: 'releases/release-10d/release.tar', artifact_sha256: 'sha-10d', created_at: '2026-03-26T00:00:00.000Z' },
      { release_id: 'release-20d', packages_json: {}, artifact_blob_key: 'releases/release-20d/release.tar', artifact_sha256: 'sha-20d', created_at: '2026-03-16T00:00:00.000Z' },
      { release_id: 'release-30d', packages_json: {}, artifact_blob_key: 'releases/release-30d/release.tar', artifact_sha256: 'sha-30d', created_at: '2026-03-06T00:00:00.000Z' },
      { release_id: 'release-40d', packages_json: {}, artifact_blob_key: 'releases/release-40d/release.tar', artifact_sha256: 'sha-40d', created_at: '2026-02-24T00:00:00.000Z' },
    ],
    jobs: [],
    objects: [
      { key: 'releases/release-active/release.tar', size: 1, lastModified: '2026-04-04T00:00:00.000Z' },
      { key: 'releases/release-2d/release.tar', size: 1, lastModified: '2026-04-03T00:00:00.000Z' },
      { key: 'releases/release-10d/release.tar', size: 1, lastModified: '2026-03-26T00:00:00.000Z' },
      { key: 'releases/release-20d/release.tar', size: 1, lastModified: '2026-03-16T00:00:00.000Z' },
      { key: 'releases/release-30d/release.tar', size: 1, lastModified: '2026-03-06T00:00:00.000Z' },
      { key: 'releases/release-40d/release.tar', size: 1, lastModified: '2026-02-24T00:00:00.000Z' },
    ],
  }, new Date('2026-04-05T12:00:00.000Z'));

  const deleted = {
    jobs: [] as string[],
    releases: [] as string[],
    objects: [] as string[],
  };
  let auditCalls = 0;

  const result = await cleanup.pruneManagedRuntimeLibrariesState({
    apply: true,
    driver: {
      audit: async () => {
        auditCalls += 1;
        return auditCalls === 1 ? before : after;
      },
      deleteJobs: async (jobIds) => {
        deleted.jobs = [...jobIds];
        return jobIds.length;
      },
      deleteReleases: async (releaseIds) => {
        deleted.releases = [...releaseIds];
        return releaseIds.length;
      },
      deleteObjects: async (keys) => {
        deleted.objects = [...keys].sort();
        return keys.length;
      },
    },
  });

  assert.deepEqual(deleted.jobs, ['job-prune']);
  assert.deepEqual(deleted.releases, ['release-prune']);
  assert.deepEqual(deleted.objects, ['orphaned/old.tar', 'releases/release-prune/release.tar']);
  assert.equal(result.deletedJobCount, 1);
  assert.equal(result.deletedReleaseCount, 1);
  assert.equal(result.deletedObjectCount, 2);
  assert.equal(result.after.totalReleaseCount, 6);
});

test('managed runtime-library prune fails if retained releases still miss artifacts after apply', async () => {
  const before = cleanup.buildManagedRuntimeLibrariesAuditSnapshotFromState({
    activeReleaseId: 'release-active',
    releases: [
      { release_id: 'release-active', packages_json: {}, artifact_blob_key: 'releases/release-active/release.tar', artifact_sha256: 'sha-active', created_at: '2026-04-04T00:00:00.000Z' },
    ],
    jobs: [],
    objects: [],
  }, new Date('2026-04-05T12:00:00.000Z'));

  await assert.rejects(
    cleanup.pruneManagedRuntimeLibrariesState({
      apply: true,
      driver: {
        audit: async () => before,
        deleteJobs: async () => 0,
        deleteReleases: async () => 0,
        deleteObjects: async () => 0,
      },
    }),
    /Retained release rows still reference missing artifacts/,
  );
});
