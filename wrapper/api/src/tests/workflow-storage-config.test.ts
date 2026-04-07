import assert from 'node:assert/strict';
import test from 'node:test';

const storageConfig = await import('../routes/workflows/storage-config.js');
const blobStore = await import('../routes/workflows/managed/blob-store.js');
const envParsing = await import('../utils/env-parsing.js');

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
  'RIVET_OBJECT_STORAGE_BUCKET',
  'RIVET_OBJECT_STORAGE_REGION',
  'RIVET_OBJECT_STORAGE_ENDPOINT',
  'RIVET_OBJECT_STORAGE_ACCESS_KEY_ID',
  'RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_OBJECT_STORAGE_PREFIX',
  'RIVET_OBJECT_STORAGE_FORCE_PATH_STYLE',
  'RIVET_WORKFLOWS_DATABASE_MODE',
  'RIVET_WORKFLOWS_DATABASE_URL',
  'RIVET_WORKFLOWS_DATABASE_CONNECTION_STRING',
  'RIVET_WORKFLOWS_DATABASE_SSL_MODE',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_BUCKET',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_REGION',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_ENDPOINT',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_ACCESS_KEY_ID',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_PREFIX',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_FORCE_PATH_STYLE',
  'RIVET_WORKFLOWS_STORAGE_URL',
  'RIVET_WORKFLOWS_STORAGE_BUCKET',
  'RIVET_WORKFLOWS_STORAGE_REGION',
  'RIVET_WORKFLOWS_STORAGE_ENDPOINT',
  'RIVET_WORKFLOWS_STORAGE_ACCESS_KEY_ID',
  'RIVET_WORKFLOWS_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_PREFIX',
  'RIVET_WORKFLOWS_STORAGE_FORCE_PATH_STYLE',
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

test('managed storage config accepts simplified alias envs for DigitalOcean-style storage URLs', async () => {
  await withManagedEnv({
    RIVET_DATABASE_MODE: 'managed',
    RIVET_DATABASE_CONNECTION_STRING: 'postgresql://db-user:db-pass@example-db:25060/defaultdb?sslmode=disable',
    RIVET_STORAGE_URL: 'https://test-bucket-111.sfo3.digitaloceanspaces.com',
    RIVET_STORAGE_ACCESS_KEY_ID: 'spaces-access-key-id',
    RIVET_STORAGE_ACCESS_KEY: 'spaces-secret-access-key',
  }, () => {
    const config = storageConfig.getManagedWorkflowStorageConfig();

    assert.equal(config.databaseMode, 'managed');
    assert.equal(config.databaseUrl, 'postgresql://db-user:db-pass@example-db:25060/defaultdb');
    assert.equal(config.databaseSslMode, 'require');
    assert.equal(config.objectStorageBucket, 'test-bucket-111');
    assert.equal(config.objectStorageRegion, 'sfo3');
    assert.equal(config.objectStorageEndpoint, 'https://sfo3.digitaloceanspaces.com');
    assert.equal(config.objectStorageAccessKeyId, 'spaces-access-key-id');
    assert.equal(config.objectStorageSecretAccessKey, 'spaces-secret-access-key');
    assert.equal(config.objectStoragePrefix, 'workflows/');
    assert.equal(config.objectStorageForcePathStyle, false);
  });
});

test('storage backend selection prefers the generic storage-mode env name', async () => {
  await withManagedEnv({
    RIVET_STORAGE_MODE: 'managed',
  }, () => {
    assert.equal(storageConfig.getWorkflowStorageBackendMode(), 'managed');
    assert.equal(storageConfig.isManagedWorkflowStorageEnabled(), true);
  });
});

test('managed storage config accepts path-style storage URLs for local Docker rehearsal', async () => {
  await withManagedEnv({
    RIVET_DATABASE_MODE: 'local-docker',
    RIVET_DATABASE_CONNECTION_STRING: 'postgres://rivet:rivet@workflow-postgres:5432/rivet?sslmode=require',
    RIVET_STORAGE_URL: 'http://workflow-minio:9000/rivet-workflows',
    RIVET_STORAGE_ACCESS_KEY_ID: 'minioadmin',
    RIVET_STORAGE_ACCESS_KEY: 'minioadmin',
    RIVET_STORAGE_PREFIX: 'managed-workflows/',
  }, () => {
    const config = storageConfig.getManagedWorkflowStorageConfig();

    assert.equal(config.databaseMode, 'local-docker');
    assert.equal(config.databaseUrl, 'postgres://rivet:rivet@workflow-postgres:5432/rivet');
    assert.equal(config.databaseSslMode, 'disable');
    assert.equal(config.objectStorageBucket, 'rivet-workflows');
    assert.equal(config.objectStorageRegion, 'us-east-1');
    assert.equal(config.objectStorageEndpoint, 'http://workflow-minio:9000');
    assert.equal(config.objectStorageAccessKeyId, 'minioadmin');
    assert.equal(config.objectStorageSecretAccessKey, 'minioadmin');
    assert.equal(config.objectStoragePrefix, 'managed-workflows/');
    assert.equal(config.objectStorageForcePathStyle, true);
  });
});

test('managed storage config rejects retired alias env names', async () => {
  await withManagedEnv({
    RIVET_WORKFLOWS_STORAGE_BACKEND: 'managed',
  }, () => {
    assert.throws(
      () => storageConfig.getWorkflowStorageBackendMode(),
      /Retired environment variable/,
    );
  });
});

test('managed storage config rejects retired legacy workflow-prefixed env names', async () => {
  await withManagedEnv({
    RIVET_WORKFLOWS_DATABASE_MODE: 'managed',
    RIVET_WORKFLOWS_DATABASE_CONNECTION_STRING: 'postgresql://legacy-user:legacy-pass@example-db:25060/defaultdb',
    RIVET_WORKFLOWS_STORAGE_URL: 'https://legacy-bucket.lon1.digitaloceanspaces.com',
    RIVET_WORKFLOWS_STORAGE_ACCESS_KEY_ID: 'legacy-access-key-id',
    RIVET_WORKFLOWS_STORAGE_ACCESS_KEY: 'legacy-secret-access-key',
  }, () => {
    assert.throws(
      () => storageConfig.getManagedWorkflowStorageConfig(),
      /Retired environment variable/,
    );
  });
});

test('managed revision blob keys do not duplicate the workflows namespace segment', () => {
  assert.equal(
    blobStore.createRevisionBlobKey('workflow-123', 'revision-456', 'project'),
    'workflow-123/revisions/revision-456/project.rivet-project',
  );
  assert.equal(
    blobStore.createRevisionBlobKey('workflow-123', 'revision-456', 'dataset'),
    'workflow-123/revisions/revision-456/dataset.rivet-data',
  );
});

test('managed recording blob keys do not duplicate the workflows namespace segment', () => {
  assert.equal(
    blobStore.createRecordingBlobKey('workflow-123', 'recording-456', 'recording'),
    'workflow-123/recordings/recording-456/recording.rivet-recording',
  );
  assert.equal(
    blobStore.createRecordingBlobKey('workflow-123', 'recording-456', 'replay-project'),
    'workflow-123/recordings/recording-456/replay.rivet-project',
  );
  assert.equal(
    blobStore.createRecordingBlobKey('workflow-123', 'recording-456', 'replay-dataset'),
    'workflow-123/recordings/recording-456/replay.rivet-data',
  );
});

test('shared env integer parsers preserve fallback and clamp semantics', () => {
  assert.equal(envParsing.parsePositiveInt(undefined, 7), 7);
  assert.equal(envParsing.parsePositiveInt('0', 7), 7);
  assert.equal(envParsing.parsePositiveInt('-5', 7), 7);
  assert.equal(envParsing.parsePositiveInt('9', 7), 9);

  assert.equal(envParsing.parseIntWithMinimum(undefined, 7, 0), 7);
  assert.equal(envParsing.parseIntWithMinimum('-5', 7, 0), 0);
  assert.equal(envParsing.parseIntWithMinimum('0', 7, 0), 0);
  assert.equal(envParsing.parseIntWithMinimum('9', 7, 0), 9);
});
