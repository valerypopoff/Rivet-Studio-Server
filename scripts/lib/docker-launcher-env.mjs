export const retiredEnvReplacements = {
  RIVET_STORAGE_BACKEND: 'RIVET_STORAGE_MODE',
  RIVET_WORKFLOWS_STORAGE_BACKEND: 'RIVET_STORAGE_MODE',
  RIVET_DATABASE_URL: 'RIVET_DATABASE_CONNECTION_STRING',
  RIVET_WORKFLOWS_DATABASE_MODE: 'RIVET_DATABASE_MODE',
  RIVET_WORKFLOWS_DATABASE_URL: 'RIVET_DATABASE_CONNECTION_STRING',
  RIVET_WORKFLOWS_DATABASE_CONNECTION_STRING: 'RIVET_DATABASE_CONNECTION_STRING',
  RIVET_WORKFLOWS_DATABASE_SSL_MODE: 'RIVET_DATABASE_SSL_MODE',
  RIVET_OBJECT_STORAGE_BUCKET: 'RIVET_STORAGE_BUCKET',
  RIVET_OBJECT_STORAGE_REGION: 'RIVET_STORAGE_REGION',
  RIVET_OBJECT_STORAGE_ENDPOINT: 'RIVET_STORAGE_ENDPOINT',
  RIVET_OBJECT_STORAGE_ACCESS_KEY_ID: 'RIVET_STORAGE_ACCESS_KEY_ID',
  RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY: 'RIVET_STORAGE_ACCESS_KEY',
  RIVET_STORAGE_SECRET_ACCESS_KEY: 'RIVET_STORAGE_ACCESS_KEY',
  RIVET_OBJECT_STORAGE_PREFIX: 'RIVET_STORAGE_PREFIX',
  RIVET_OBJECT_STORAGE_FORCE_PATH_STYLE: 'RIVET_STORAGE_FORCE_PATH_STYLE',
  RIVET_WORKFLOWS_STORAGE_URL: 'RIVET_STORAGE_URL',
  RIVET_WORKFLOWS_STORAGE_BUCKET: 'RIVET_STORAGE_BUCKET',
  RIVET_WORKFLOWS_STORAGE_REGION: 'RIVET_STORAGE_REGION',
  RIVET_WORKFLOWS_STORAGE_ENDPOINT: 'RIVET_STORAGE_ENDPOINT',
  RIVET_WORKFLOWS_STORAGE_ACCESS_KEY_ID: 'RIVET_STORAGE_ACCESS_KEY_ID',
  RIVET_WORKFLOWS_STORAGE_SECRET_ACCESS_KEY: 'RIVET_STORAGE_ACCESS_KEY',
  RIVET_WORKFLOWS_STORAGE_ACCESS_KEY: 'RIVET_STORAGE_ACCESS_KEY',
  RIVET_WORKFLOWS_STORAGE_PREFIX: 'RIVET_STORAGE_PREFIX',
  RIVET_WORKFLOWS_STORAGE_FORCE_PATH_STYLE: 'RIVET_STORAGE_FORCE_PATH_STYLE',
  RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS: 'RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS',
};

export function readNormalizedEnv(env, ...names) {
  for (const name of names) {
    const value = String(env[name] ?? '').trim().toLowerCase();
    if (value) {
      return value;
    }
  }

  return '';
}

export function listActiveRetiredEnv(env) {
  return Object.entries(retiredEnvReplacements)
    .filter(([name]) => String(env[name] ?? '').trim())
    .map(([name, replacement]) => `${name} -> ${replacement}`);
}

export function assertNoRetiredEnv(env, options = {}) {
  const activeRetired = listActiveRetiredEnv(env);

  if (activeRetired.length === 0) {
    return;
  }

  const launcherName = options.launcherName ?? 'docker-launcher';
  const envFileLabel = options.envFileLabel ?? '.env';

  throw new Error(
    `[${launcherName}] Retired environment variable(s) detected in ${envFileLabel}: ${activeRetired.join(', ')}. ` +
    'Update the env file to the canonical names before starting the stack.',
  );
}

export function enableManagedWorkflowProfileIfNeeded(env) {
  const storageBackend = readNormalizedEnv(env, 'RIVET_STORAGE_MODE');
  const databaseMode = readNormalizedEnv(env, 'RIVET_DATABASE_MODE');
  if (storageBackend !== 'managed' || databaseMode !== 'local-docker') {
    return env;
  }

  const existingProfiles = String(env.COMPOSE_PROFILES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!existingProfiles.includes('workflow-managed')) {
    existingProfiles.push('workflow-managed');
    env.COMPOSE_PROFILES = existingProfiles.join(',');
  }

  return env;
}
