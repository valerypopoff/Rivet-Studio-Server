import {
  getManagedWorkflowStorageConfig,
  type ManagedWorkflowStorageConfig,
} from '../routes/workflows/storage-config.js';
import { badRequest } from '../utils/httpError.js';
import type { RuntimeLibrariesBackendMode } from '../../../shared/runtime-library-types.js';

export type ManagedRuntimeLibrariesConfig = Omit<ManagedWorkflowStorageConfig, 'objectStoragePrefix'> & {
  objectStoragePrefix: string;
  syncPollIntervalMs: number;
};

export const MANAGED_RUNTIME_LIBRARIES_OBJECT_STORAGE_PREFIX = 'runtime-libraries/';

const STORAGE_MODE_ENV_NAME = 'RIVET_STORAGE_MODE';
const RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_ENV_NAME = 'RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS';
const RETIRED_ENV_REPLACEMENTS = {
  RIVET_STORAGE_BACKEND: STORAGE_MODE_ENV_NAME,
  RIVET_WORKFLOWS_STORAGE_BACKEND: STORAGE_MODE_ENV_NAME,
  RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS: RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_ENV_NAME,
} as const;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function normalizeEnumValue<T extends string>(
  rawValue: string | undefined,
  allowedValues: readonly T[],
  fallback: T,
): T {
  const normalized = rawValue?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if ((allowedValues as readonly string[]).includes(normalized)) {
    return normalized as T;
  }

  throw badRequest(`Invalid configuration value "${rawValue}"`);
}

function normalizePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
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
    'Use the canonical runtime-library storage env names.',
  );
}

export function getRuntimeLibrariesBackendMode(): RuntimeLibrariesBackendMode {
  assertNoRetiredEnv();
  return normalizeEnumValue(
    readEnv(STORAGE_MODE_ENV_NAME),
    ['filesystem', 'managed'],
    'filesystem',
  );
}

export function isManagedRuntimeLibrariesEnabled(): boolean {
  return getRuntimeLibrariesBackendMode() === 'managed';
}

export function getManagedRuntimeLibrariesConfig(): ManagedRuntimeLibrariesConfig {
  assertNoRetiredEnv();
  const workflowConfig = getManagedWorkflowStorageConfig();

  return {
    ...workflowConfig,
    objectStoragePrefix: MANAGED_RUNTIME_LIBRARIES_OBJECT_STORAGE_PREFIX,
    syncPollIntervalMs: normalizePositiveInt(
      readEnv(RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_ENV_NAME),
      5_000,
    ),
  };
}
