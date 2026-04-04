import { badRequest } from '../../utils/httpError.js';

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

const STORAGE_MODE_ENV_NAMES = [
  'RIVET_STORAGE_MODE',
  'RIVET_STORAGE_BACKEND',
  'RIVET_WORKFLOWS_STORAGE_BACKEND',
] as const;

const DATABASE_MODE_ENV_NAMES = [
  'RIVET_DATABASE_MODE',
  'RIVET_WORKFLOWS_DATABASE_MODE',
] as const;

const DATABASE_URL_ENV_NAMES = [
  'RIVET_DATABASE_URL',
  'RIVET_DATABASE_CONNECTION_STRING',
  'RIVET_WORKFLOWS_DATABASE_URL',
  'RIVET_WORKFLOWS_DATABASE_CONNECTION_STRING',
] as const;

const DATABASE_SSL_MODE_ENV_NAMES = [
  'RIVET_DATABASE_SSL_MODE',
  'RIVET_WORKFLOWS_DATABASE_SSL_MODE',
] as const;

const STORAGE_URL_ENV_NAMES = [
  'RIVET_STORAGE_URL',
  'RIVET_WORKFLOWS_STORAGE_URL',
] as const;

const OBJECT_STORAGE_BUCKET_ENV_NAMES = [
  'RIVET_OBJECT_STORAGE_BUCKET',
  'RIVET_STORAGE_BUCKET',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_BUCKET',
  'RIVET_WORKFLOWS_STORAGE_BUCKET',
] as const;

const OBJECT_STORAGE_REGION_ENV_NAMES = [
  'RIVET_OBJECT_STORAGE_REGION',
  'RIVET_STORAGE_REGION',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_REGION',
  'RIVET_WORKFLOWS_STORAGE_REGION',
] as const;

const OBJECT_STORAGE_ENDPOINT_ENV_NAMES = [
  'RIVET_OBJECT_STORAGE_ENDPOINT',
  'RIVET_STORAGE_ENDPOINT',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_ENDPOINT',
  'RIVET_WORKFLOWS_STORAGE_ENDPOINT',
] as const;

const OBJECT_STORAGE_ACCESS_KEY_ID_ENV_NAMES = [
  'RIVET_OBJECT_STORAGE_ACCESS_KEY_ID',
  'RIVET_STORAGE_ACCESS_KEY_ID',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_ACCESS_KEY_ID',
  'RIVET_WORKFLOWS_STORAGE_ACCESS_KEY_ID',
] as const;

const OBJECT_STORAGE_SECRET_ACCESS_KEY_ENV_NAMES = [
  'RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_STORAGE_ACCESS_KEY',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_SECRET_ACCESS_KEY',
  'RIVET_WORKFLOWS_STORAGE_ACCESS_KEY',
] as const;

const OBJECT_STORAGE_PREFIX_ENV_NAMES = [
  'RIVET_OBJECT_STORAGE_PREFIX',
  'RIVET_STORAGE_PREFIX',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_PREFIX',
  'RIVET_WORKFLOWS_STORAGE_PREFIX',
] as const;

const OBJECT_STORAGE_FORCE_PATH_STYLE_ENV_NAMES = [
  'RIVET_OBJECT_STORAGE_FORCE_PATH_STYLE',
  'RIVET_STORAGE_FORCE_PATH_STYLE',
  'RIVET_WORKFLOWS_OBJECT_STORAGE_FORCE_PATH_STYLE',
  'RIVET_WORKFLOWS_STORAGE_FORCE_PATH_STYLE',
] as const;

function stripDatabaseSslQueryOptions(rawConnectionString: string): string {
  try {
    const url = new URL(rawConnectionString);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return rawConnectionString;
  }
}

function normalizeEnumValue<T extends string>(rawValue: string | undefined, allowedValues: readonly T[], fallback: T): T {
  const normalized = rawValue?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if ((allowedValues as readonly string[]).includes(normalized)) {
    return normalized as T;
  }

  throw badRequest(`Invalid configuration value "${rawValue}"`);
}

function normalizeBoolean(value: string | undefined, fallback = false): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function readFirstDefinedEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function requireOneOfEnv(...names: string[]): string {
  const value = readFirstDefinedEnv(...names);
  if (!value) {
    throw new Error(`Missing required environment variable: ${names.join(' or ')}`);
  }

  return value;
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
  return normalizeEnumValue(readFirstDefinedEnv(...STORAGE_MODE_ENV_NAMES), ['filesystem', 'managed'], 'filesystem');
}

export function isManagedWorkflowStorageEnabled(): boolean {
  return getWorkflowStorageBackendMode() === 'managed';
}

export function getManagedWorkflowStorageConfig(): ManagedWorkflowStorageConfig {
  const databaseMode = normalizeEnumValue(readFirstDefinedEnv(...DATABASE_MODE_ENV_NAMES), ['local-docker', 'managed'], 'managed');
  const databaseUrl = stripDatabaseSslQueryOptions(
    requireOneOfEnv(...DATABASE_URL_ENV_NAMES),
  );
  const storageUrl = readFirstDefinedEnv(...STORAGE_URL_ENV_NAMES);
  const parsedStorageUrl = storageUrl ? parseManagedStorageUrl(storageUrl) : null;
  const explicitRegion = readFirstDefinedEnv(...OBJECT_STORAGE_REGION_ENV_NAMES);
  const explicitEndpoint = readFirstDefinedEnv(...OBJECT_STORAGE_ENDPOINT_ENV_NAMES);

  return {
    databaseMode,
    databaseUrl,
    databaseSslMode: normalizeEnumValue(
      readFirstDefinedEnv(...DATABASE_SSL_MODE_ENV_NAMES),
      ['disable', 'require', 'verify-full'],
      databaseMode === 'local-docker' ? 'disable' : 'require',
    ),
    objectStorageBucket: readFirstDefinedEnv(
      ...OBJECT_STORAGE_BUCKET_ENV_NAMES,
    ) || parsedStorageUrl?.bucket || requireOneOfEnv(...OBJECT_STORAGE_BUCKET_ENV_NAMES),
    objectStorageRegion: explicitRegion || parsedStorageUrl?.region || 'us-east-1',
    objectStorageEndpoint: explicitEndpoint || parsedStorageUrl?.endpoint || null,
    objectStorageAccessKeyId: requireOneOfEnv(...OBJECT_STORAGE_ACCESS_KEY_ID_ENV_NAMES),
    objectStorageSecretAccessKey: requireOneOfEnv(...OBJECT_STORAGE_SECRET_ACCESS_KEY_ENV_NAMES),
    objectStoragePrefix: (readFirstDefinedEnv(...OBJECT_STORAGE_PREFIX_ENV_NAMES) || 'workflows/').replace(/^\/+/, ''),
    objectStorageForcePathStyle: normalizeBoolean(
      readFirstDefinedEnv(...OBJECT_STORAGE_FORCE_PATH_STYLE_ENV_NAMES),
      parsedStorageUrl?.forcePathStyle ?? false,
    ),
  };
}
