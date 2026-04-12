function parseEnv(rawValue, parser, fallback) {
  const normalized = rawValue?.trim();
  if (!normalized) {
    return fallback;
  }

  return parser(normalized, fallback);
}

function normalizeBoolean(value, fallback = false) {
  return parseEnv(value, (normalized) => {
    const lower = normalized.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lower)) {
      return true;
    }

    if (['0', 'false', 'no', 'off'].includes(lower)) {
      return false;
    }

    return fallback;
  }, fallback);
}

function normalizePositiveInt(value, fallback) {
  return parseEnv(value, (normalized) => {
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }, fallback);
}

function stripDatabaseSslQueryOptions(rawConnectionString) {
  try {
    const url = new URL(rawConnectionString);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return rawConnectionString;
  }
}

function parseManagedStorageUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid storage URL "${rawUrl}"`);
  }

  const pathSegments = url.pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const hostParts = url.hostname.split('.').filter(Boolean);

  if (pathSegments.length > 0) {
    return {
      bucket: pathSegments[0],
      endpoint: url.origin,
      region: hostParts[0] === 's3' && hostParts[1] ? hostParts[1] : null,
      forcePathStyle: true,
    };
  }

  if (hostParts.length >= 2) {
    let region = null;
    let endpointHost = hostParts.slice(1).join('.');
    if (url.hostname.endsWith('.digitaloceanspaces.com') && hostParts.length >= 3) {
      region = hostParts[1] ?? null;
      endpointHost = hostParts.slice(1).join('.');
    } else if (hostParts[1] === 's3') {
      region = hostParts[2] ?? null;
      endpointHost = hostParts.slice(1).join('.');
    }

    return {
      bucket: hostParts[0],
      endpoint: `${url.protocol}//${endpointHost}`,
      region,
      forcePathStyle: false,
    };
  }

  throw new Error(`Storage URL "${rawUrl}" does not include a bucket name`);
}

const DATABASE_CONNECTION_STRING_ENV_NAME = 'RIVET_DATABASE_CONNECTION_STRING';
const DATABASE_SSL_MODE_ENV_NAME = 'RIVET_DATABASE_SSL_MODE';
const DATABASE_MODE_ENV_NAME = 'RIVET_DATABASE_MODE';
const OBJECT_STORAGE_BUCKET_ENV_NAME = 'RIVET_STORAGE_BUCKET';
const STORAGE_URL_ENV_NAME = 'RIVET_STORAGE_URL';
const OBJECT_STORAGE_REGION_ENV_NAME = 'RIVET_STORAGE_REGION';
const OBJECT_STORAGE_ENDPOINT_ENV_NAME = 'RIVET_STORAGE_ENDPOINT';
const OBJECT_STORAGE_ACCESS_KEY_ID_ENV_NAME = 'RIVET_STORAGE_ACCESS_KEY_ID';
const OBJECT_STORAGE_ACCESS_KEY_ENV_NAME = 'RIVET_STORAGE_ACCESS_KEY';
const OBJECT_STORAGE_FORCE_PATH_STYLE_ENV_NAME = 'RIVET_STORAGE_FORCE_PATH_STYLE';
const STORAGE_MODE_ENV_NAME = 'RIVET_STORAGE_MODE';
const RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS';
const RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS';
const RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS';
const RUNTIME_PROCESS_ROLE_ENV_NAME = 'RIVET_RUNTIME_PROCESS_ROLE';
const RUNTIME_REPLICA_TIER_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_REPLICA_TIER';
const RUNTIME_LIBRARIES_JOB_WORKER_ENABLED_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED';

export const MANAGED_RUNTIME_LIBRARIES_OBJECT_STORAGE_PREFIX = 'runtime-libraries/';

const RETIRED_ENV_REPLACEMENTS = {
  RIVET_STORAGE_BACKEND: STORAGE_MODE_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_BACKEND: STORAGE_MODE_ENV_NAME,
  RIVET_DATABASE_URL: DATABASE_CONNECTION_STRING_ENV_NAME,
  RIVET_WORKFLOWS_DATABASE_MODE: DATABASE_MODE_ENV_NAME,
  RIVET_WORKFLOWS_DATABASE_URL: DATABASE_CONNECTION_STRING_ENV_NAME,
  RIVET_WORKFLOWS_DATABASE_CONNECTION_STRING: DATABASE_CONNECTION_STRING_ENV_NAME,
  RIVET_WORKFLOWS_DATABASE_SSL_MODE: DATABASE_SSL_MODE_ENV_NAME,
  RIVET_OBJECT_STORAGE_BUCKET: OBJECT_STORAGE_BUCKET_ENV_NAME,
  RIVET_OBJECT_STORAGE_REGION: OBJECT_STORAGE_REGION_ENV_NAME,
  RIVET_OBJECT_STORAGE_ENDPOINT: OBJECT_STORAGE_ENDPOINT_ENV_NAME,
  RIVET_OBJECT_STORAGE_ACCESS_KEY_ID: OBJECT_STORAGE_ACCESS_KEY_ID_ENV_NAME,
  RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY: OBJECT_STORAGE_ACCESS_KEY_ENV_NAME,
  RIVET_STORAGE_SECRET_ACCESS_KEY: OBJECT_STORAGE_ACCESS_KEY_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_URL: STORAGE_URL_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_BUCKET: OBJECT_STORAGE_BUCKET_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_REGION: OBJECT_STORAGE_REGION_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_ENDPOINT: OBJECT_STORAGE_ENDPOINT_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_ACCESS_KEY_ID: OBJECT_STORAGE_ACCESS_KEY_ID_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_SECRET_ACCESS_KEY: OBJECT_STORAGE_ACCESS_KEY_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_ACCESS_KEY: OBJECT_STORAGE_ACCESS_KEY_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_FORCE_PATH_STYLE: OBJECT_STORAGE_FORCE_PATH_STYLE_ENV_NAME,
  RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS: RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_ENV_NAME,
};

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function assertNoRetiredEnv() {
  const activeRetired = Object.entries(RETIRED_ENV_REPLACEMENTS)
    .filter(([name]) => Boolean(process.env[name]?.trim()))
    .map(([name, replacement]) => `${name} -> ${replacement}`);

  if (activeRetired.length === 0) {
    return;
  }

  throw new Error(
    `Retired environment variable(s) detected: ${activeRetired.join(', ')}. ` +
    'Update the configuration to the canonical RIVET_STORAGE_* / RIVET_DATABASE_* names.',
  );
}

function inferRuntimeProcessRole() {
  const rawExplicitRole = readEnv(RUNTIME_PROCESS_ROLE_ENV_NAME);
  const explicitRole = rawExplicitRole?.toLowerCase();
  if (explicitRole === 'api' || explicitRole === 'executor') {
    return explicitRole;
  }

  if (rawExplicitRole) {
    throw new Error(
      `Invalid configuration value "${rawExplicitRole}" for ${RUNTIME_PROCESS_ROLE_ENV_NAME}. ` +
      'Expected "api" or "executor".',
    );
  }

  const argv = process.argv.join(' ').toLowerCase();
  if (argv.includes('executor-bundle') || argv.includes('app-executor')) {
    return 'executor';
  }

  return 'api';
}

function inferRuntimeReplicaTier(runtimeProcessRole) {
  const rawExplicitTier = readEnv(RUNTIME_REPLICA_TIER_ENV_NAME);
  const explicitTier = rawExplicitTier?.toLowerCase();
  if (explicitTier === 'endpoint' || explicitTier === 'editor' || explicitTier === 'none') {
    return explicitTier;
  }

  if (rawExplicitTier) {
    throw new Error(
      `Invalid configuration value "${rawExplicitTier}" for ${RUNTIME_REPLICA_TIER_ENV_NAME}. ` +
      'Expected "endpoint", "editor", or "none".',
    );
  }

  return runtimeProcessRole === 'executor' ? 'editor' : 'endpoint';
}

function getDefaultReplicaStatusRetentionMs(databaseMode) {
  return databaseMode === 'local-docker'
    ? 24 * 60 * 60 * 1_000
    : 15 * 60 * 1_000;
}

function getDefaultReplicaStatusCleanupIntervalMs(databaseMode) {
  return databaseMode === 'local-docker'
    ? 15 * 60 * 1_000
    : 5 * 60 * 1_000;
}

function getNormalizedArgv() {
  return process.argv.map((arg) => arg.replace(/\\/g, '/').toLowerCase());
}

function isApiRuntimeEntryArg(arg) {
  return arg === 'src/server.ts' ||
    arg.endsWith('/src/server.ts') ||
    arg === 'dist/api/src/server.js' ||
    arg.endsWith('/dist/api/src/server.js');
}

function isExecutorRuntimeEntryArg(arg) {
  return arg.includes('executor-bundle') || arg.includes('app-executor');
}

export function isManagedRuntimeLibrariesEnabled() {
  assertNoRetiredEnv();
  const storageMode = readEnv(STORAGE_MODE_ENV_NAME)?.toLowerCase();
  return storageMode === 'managed';
}

export function shouldBootstrapManagedRuntimeLibrariesInCurrentProcess() {
  if (!isManagedRuntimeLibrariesEnabled()) {
    return false;
  }

  const argv = getNormalizedArgv();
  const runtimeProcessRole = inferRuntimeProcessRole();

  if (runtimeProcessRole === 'executor') {
    return argv.some(isExecutorRuntimeEntryArg);
  }

  if (argv.includes('watch')) {
    return false;
  }

  return argv.some(isApiRuntimeEntryArg);
}

export function getManagedRuntimeLibrariesConfig() {
  assertNoRetiredEnv();
  const databaseUrl = stripDatabaseSslQueryOptions(readEnv(DATABASE_CONNECTION_STRING_ENV_NAME) || '');
  if (!databaseUrl) {
    throw new Error(`Managed runtime-library sync requires ${DATABASE_CONNECTION_STRING_ENV_NAME}`);
  }

  const databaseMode = readEnv(DATABASE_MODE_ENV_NAME)?.toLowerCase() || 'managed';
  const databaseSslMode = readEnv(DATABASE_SSL_MODE_ENV_NAME)?.toLowerCase() || (databaseMode === 'local-docker' ? 'disable' : 'require');
  const storageUrl = readEnv(STORAGE_URL_ENV_NAME);
  const parsedStorageUrl = storageUrl ? parseManagedStorageUrl(storageUrl) : null;
  const replicaStatusRetentionMs = normalizePositiveInt(
    readEnv(RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_ENV_NAME),
    getDefaultReplicaStatusRetentionMs(databaseMode),
  );
  const runtimeProcessRole = inferRuntimeProcessRole();

  return {
    databaseMode,
    databaseUrl,
    databaseSslMode,
    objectStorageBucket: readEnv(OBJECT_STORAGE_BUCKET_ENV_NAME) || parsedStorageUrl?.bucket,
    objectStorageRegion: readEnv(OBJECT_STORAGE_REGION_ENV_NAME) || parsedStorageUrl?.region || 'us-east-1',
    objectStorageEndpoint: readEnv(OBJECT_STORAGE_ENDPOINT_ENV_NAME) || parsedStorageUrl?.endpoint || undefined,
    objectStorageAccessKeyId: readEnv(OBJECT_STORAGE_ACCESS_KEY_ID_ENV_NAME),
    objectStorageSecretAccessKey: readEnv(OBJECT_STORAGE_ACCESS_KEY_ENV_NAME),
    objectStorageForcePathStyle: normalizeBoolean(
      readEnv(OBJECT_STORAGE_FORCE_PATH_STYLE_ENV_NAME),
      parsedStorageUrl?.forcePathStyle ?? false,
    ),
    objectStoragePrefix: MANAGED_RUNTIME_LIBRARIES_OBJECT_STORAGE_PREFIX,
    syncPollIntervalMs: normalizePositiveInt(readEnv(RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_ENV_NAME), 5_000),
    runtimeProcessRole,
    runtimeReplicaTier: inferRuntimeReplicaTier(runtimeProcessRole),
    replicaStatusRetentionMs,
    replicaStatusCleanupIntervalMs: normalizePositiveInt(
      readEnv(RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_ENV_NAME),
      getDefaultReplicaStatusCleanupIntervalMs(databaseMode),
    ),
    jobWorkerEnabled: normalizeBoolean(
      readEnv(RUNTIME_LIBRARIES_JOB_WORKER_ENABLED_ENV_NAME),
      true,
    ),
  };
}

export function getManagedRuntimeLibrariesPoolConfig(config) {
  const sharedConfig = {
    connectionString: config.databaseUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    idleTimeoutMillis: 30_000,
    max: 2,
  };

  if (config.databaseSslMode === 'disable') {
    return sharedConfig;
  }

  return {
    ...sharedConfig,
    ssl: {
      rejectUnauthorized: config.databaseSslMode === 'verify-full',
    },
  };
}
