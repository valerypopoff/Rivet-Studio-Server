import { badRequest } from '../../utils/httpError.js';
import { parseBoolean, parseEnum } from '../../utils/env-parsing.js';

export type WorkflowStorageBackendMode = 'filesystem' | 'managed';
export type ManagedWorkflowDatabaseMode = 'local-docker' | 'managed';
export type ManagedWorkflowDatabaseSslMode = 'disable' | 'require' | 'verify-full';

export type ManagedWorkflowStorageConfig = {
  databaseMode: ManagedWorkflowDatabaseMode;
  databaseUrl: string;
  databaseSslMode: ManagedWorkflowDatabaseSslMode;
  objectStorageBucket: string;
  objectStorageRegion: string;
  objectStorageEndpoint: string | null;
  objectStorageAccessKeyId: string;
  objectStorageSecretAccessKey: string;
  objectStoragePrefix: string;
  objectStorageForcePathStyle: boolean;
};

type ParsedStorageUrl = {
  bucket: string;
  endpoint: string | null;
  region: string | null;
  forcePathStyle: boolean;
};

const STORAGE_MODE_ENV_NAME = 'RIVET_STORAGE_MODE';
const DATABASE_MODE_ENV_NAME = 'RIVET_DATABASE_MODE';
const DATABASE_CONNECTION_STRING_ENV_NAME = 'RIVET_DATABASE_CONNECTION_STRING';
const DATABASE_SSL_MODE_ENV_NAME = 'RIVET_DATABASE_SSL_MODE';
const STORAGE_URL_ENV_NAME = 'RIVET_STORAGE_URL';
const OBJECT_STORAGE_BUCKET_ENV_NAME = 'RIVET_STORAGE_BUCKET';
const OBJECT_STORAGE_REGION_ENV_NAME = 'RIVET_STORAGE_REGION';
const OBJECT_STORAGE_ENDPOINT_ENV_NAME = 'RIVET_STORAGE_ENDPOINT';
const OBJECT_STORAGE_ACCESS_KEY_ID_ENV_NAME = 'RIVET_STORAGE_ACCESS_KEY_ID';
const OBJECT_STORAGE_ACCESS_KEY_ENV_NAME = 'RIVET_STORAGE_ACCESS_KEY';
const OBJECT_STORAGE_PREFIX_ENV_NAME = 'RIVET_STORAGE_PREFIX';
const OBJECT_STORAGE_FORCE_PATH_STYLE_ENV_NAME = 'RIVET_STORAGE_FORCE_PATH_STYLE';

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
  RIVET_OBJECT_STORAGE_PREFIX: OBJECT_STORAGE_PREFIX_ENV_NAME,
  RIVET_OBJECT_STORAGE_FORCE_PATH_STYLE: OBJECT_STORAGE_FORCE_PATH_STYLE_ENV_NAME,
  RIVET_STORAGE_SECRET_ACCESS_KEY: OBJECT_STORAGE_ACCESS_KEY_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_URL: STORAGE_URL_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_BUCKET: OBJECT_STORAGE_BUCKET_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_REGION: OBJECT_STORAGE_REGION_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_ENDPOINT: OBJECT_STORAGE_ENDPOINT_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_ACCESS_KEY_ID: OBJECT_STORAGE_ACCESS_KEY_ID_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_SECRET_ACCESS_KEY: OBJECT_STORAGE_ACCESS_KEY_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_ACCESS_KEY: OBJECT_STORAGE_ACCESS_KEY_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_PREFIX: OBJECT_STORAGE_PREFIX_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_FORCE_PATH_STYLE: OBJECT_STORAGE_FORCE_PATH_STYLE_ENV_NAME,
} as const;

function stripDatabaseSslQueryOptions(rawConnectionString: string): string {
  try {
    const url = new URL(rawConnectionString);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return rawConnectionString;
  }
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function assertNoRetiredEnv(): void {
  const activeRetired = Object.entries(RETIRED_ENV_REPLACEMENTS)
    .filter(([name]) => Boolean(process.env[name]?.trim()))
    .map(([name, replacement]) => `${name} -> ${replacement}`);

  if (activeRetired.length === 0) {
    return;
  }

  throw badRequest(
    `Retired environment variable(s) detected: ${activeRetired.join(', ')}. ` +
    'Update your configuration to the canonical RIVET_STORAGE_* / RIVET_DATABASE_* names.',
  );
}

function parseManagedStorageUrl(rawUrl: string): ParsedStorageUrl {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest(`Invalid storage URL "${rawUrl}"`);
  }

  const pathSegments = url.pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const hostParts = url.hostname.split('.').filter(Boolean);

  if (pathSegments.length > 0) {
    const bucket = pathSegments[0]!;
    return {
      bucket,
      endpoint: url.origin,
      region: hostParts[0] === 's3' && hostParts[1] ? hostParts[1]! : null,
      forcePathStyle: true,
    };
  }

  if (hostParts.length >= 2) {
    const bucket = hostParts[0]!;
    let region: string | null = null;
    let endpointHost = hostParts.slice(1).join('.');

    if (url.hostname.endsWith('.digitaloceanspaces.com') && hostParts.length >= 3) {
      region = hostParts[1] ?? null;
      endpointHost = hostParts.slice(1).join('.');
    } else if (hostParts[1] === 's3') {
      region = hostParts[2] ?? null;
      endpointHost = hostParts.slice(1).join('.');
    }

    return {
      bucket,
      endpoint: `${url.protocol}//${endpointHost}`,
      region,
      forcePathStyle: false,
    };
  }

  throw badRequest(`Storage URL "${rawUrl}" does not include a bucket name`);
}

export function getWorkflowStorageBackendMode(): WorkflowStorageBackendMode {
  assertNoRetiredEnv();
  return parseEnum(readEnv(STORAGE_MODE_ENV_NAME), ['filesystem', 'managed'], 'filesystem', { strict: true });
}

export function isManagedWorkflowStorageEnabled(): boolean {
  return getWorkflowStorageBackendMode() === 'managed';
}

export function getManagedWorkflowStorageConfig(): ManagedWorkflowStorageConfig {
  assertNoRetiredEnv();
  const databaseMode = parseEnum(readEnv(DATABASE_MODE_ENV_NAME), ['local-docker', 'managed'], 'managed', { strict: true });
  const databaseUrl = stripDatabaseSslQueryOptions(
    requireEnv(DATABASE_CONNECTION_STRING_ENV_NAME),
  );
  const storageUrl = readEnv(STORAGE_URL_ENV_NAME);
  const parsedStorageUrl = storageUrl ? parseManagedStorageUrl(storageUrl) : null;
  const explicitRegion = readEnv(OBJECT_STORAGE_REGION_ENV_NAME);
  const explicitEndpoint = readEnv(OBJECT_STORAGE_ENDPOINT_ENV_NAME);

  return {
    databaseMode,
    databaseUrl,
    databaseSslMode: parseEnum(
      readEnv(DATABASE_SSL_MODE_ENV_NAME),
      ['disable', 'require', 'verify-full'],
      databaseMode === 'local-docker' ? 'disable' : 'require',
      { strict: true },
    ),
    objectStorageBucket: readEnv(OBJECT_STORAGE_BUCKET_ENV_NAME) || parsedStorageUrl?.bucket || requireEnv(OBJECT_STORAGE_BUCKET_ENV_NAME),
    objectStorageRegion: explicitRegion || parsedStorageUrl?.region || 'us-east-1',
    objectStorageEndpoint: explicitEndpoint || parsedStorageUrl?.endpoint || null,
    objectStorageAccessKeyId: requireEnv(OBJECT_STORAGE_ACCESS_KEY_ID_ENV_NAME),
    objectStorageSecretAccessKey: requireEnv(OBJECT_STORAGE_ACCESS_KEY_ENV_NAME),
    objectStoragePrefix: (readEnv(OBJECT_STORAGE_PREFIX_ENV_NAME) || 'workflows/').replace(/^\/+/, ''),
    objectStorageForcePathStyle: parseBoolean(
      readEnv(OBJECT_STORAGE_FORCE_PATH_STYLE_ENV_NAME),
      parsedStorageUrl?.forcePathStyle ?? false,
    ),
  };
}
