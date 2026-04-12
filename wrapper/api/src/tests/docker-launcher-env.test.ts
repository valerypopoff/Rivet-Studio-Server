import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const launcherEnv = await import(new URL('../../../../scripts/lib/docker-launcher-env.mjs', import.meta.url).href) as {
  assertNoRetiredEnv: (env: NodeJS.ProcessEnv, options?: { launcherName?: string; envFileLabel?: string }) => void;
  enableManagedWorkflowProfileIfNeeded: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  listActiveRetiredEnv: (env: NodeJS.ProcessEnv) => string[];
};
const devEnv = await import(new URL('../../../../scripts/lib/dev-env.mjs', import.meta.url).href) as {
  loadDevEnv: (rootDir: string) => {
    envPath: string;
    hasEnvFile: boolean;
    fileEnv: Record<string, string>;
    mergedEnv: NodeJS.ProcessEnv;
  };
};

test('filesystem launcher env does not activate the managed workflow compose profile', () => {
  const env: NodeJS.ProcessEnv = {
    RIVET_STORAGE_MODE: 'filesystem',
    RIVET_DATABASE_MODE: 'managed',
  };

  launcherEnv.enableManagedWorkflowProfileIfNeeded(env);
  assert.equal(env.COMPOSE_PROFILES, undefined);
});

test('managed local-docker launcher env activates the managed workflow compose profile once', () => {
  const env: NodeJS.ProcessEnv = {
    RIVET_STORAGE_MODE: 'managed',
    RIVET_DATABASE_MODE: 'local-docker',
    COMPOSE_PROFILES: 'alpha,workflow-managed,beta',
  };

  launcherEnv.enableManagedWorkflowProfileIfNeeded(env);
  assert.equal(env.COMPOSE_PROFILES, 'alpha,workflow-managed,beta');

  const withoutExistingProfile: NodeJS.ProcessEnv = {
    RIVET_STORAGE_MODE: 'managed',
    RIVET_DATABASE_MODE: 'local-docker',
    COMPOSE_PROFILES: 'alpha,beta',
  };

  launcherEnv.enableManagedWorkflowProfileIfNeeded(withoutExistingProfile);
  assert.equal(withoutExistingProfile.COMPOSE_PROFILES, 'alpha,beta,workflow-managed');
});

test('managed cloud launcher env does not activate the managed workflow compose profile', () => {
  const env: NodeJS.ProcessEnv = {
    RIVET_STORAGE_MODE: 'managed',
    RIVET_DATABASE_MODE: 'managed',
    COMPOSE_PROFILES: 'alpha',
  };

  launcherEnv.enableManagedWorkflowProfileIfNeeded(env);
  assert.equal(env.COMPOSE_PROFILES, 'alpha');
});

test('launcher env helpers report retired aliases with launcher-specific context', () => {
  const env: NodeJS.ProcessEnv = {
    RIVET_STORAGE_BACKEND: 'managed',
  };

  assert.deepEqual(launcherEnv.listActiveRetiredEnv(env), ['RIVET_STORAGE_BACKEND -> RIVET_STORAGE_MODE']);
  assert.throws(
    () => launcherEnv.assertNoRetiredEnv(env, { launcherName: 'dev-docker', envFileLabel: '.env.compat' }),
    /\[dev-docker\] Retired environment variable\(s\) detected in \.env\.compat: RIVET_STORAGE_BACKEND -> RIVET_STORAGE_MODE/,
  );
});

test('loadDevEnv honors explicit RIVET_ENV_FILE overrides and still derives filesystem host paths', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-dev-env-'));
  const envPath = path.join(tempRoot, 'compat.env');
  fs.writeFileSync(envPath, [
    'RIVET_STORAGE_MODE=filesystem',
    'RIVET_ARTIFACTS_HOST_PATH=./artifacts',
  ].join('\n'));

  const previousEnvFile = process.env.RIVET_ENV_FILE;
  process.env.RIVET_ENV_FILE = envPath;

  try {
    const loaded = devEnv.loadDevEnv(tempRoot);

    assert.equal(loaded.envPath, envPath);
    assert.equal(loaded.hasEnvFile, true);
    assert.equal(loaded.fileEnv.RIVET_STORAGE_MODE, 'filesystem');
    assert.equal(loaded.mergedEnv.RIVET_WORKFLOWS_HOST_PATH, path.join(tempRoot, 'artifacts', 'workflows'));
    assert.equal(loaded.mergedEnv.RIVET_WORKFLOW_RECORDINGS_HOST_PATH, path.join(tempRoot, 'artifacts', 'workflow-recordings'));
    assert.equal(loaded.mergedEnv.RIVET_RUNTIME_LIBS_HOST_PATH, path.join(tempRoot, 'artifacts', 'runtime-libraries'));
  } finally {
    if (previousEnvFile == null) {
      delete process.env.RIVET_ENV_FILE;
    } else {
      process.env.RIVET_ENV_FILE = previousEnvFile;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('loadDevEnv preserves an explicit workflow recordings host path override', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-dev-env-recordings-'));
  const envPath = path.join(tempRoot, 'compat.env');
  fs.writeFileSync(envPath, [
    'RIVET_STORAGE_MODE=filesystem',
    'RIVET_ARTIFACTS_HOST_PATH=./artifacts',
    'RIVET_WORKFLOW_RECORDINGS_HOST_PATH=./custom-recordings',
  ].join('\n'));

  const previousEnvFile = process.env.RIVET_ENV_FILE;
  process.env.RIVET_ENV_FILE = envPath;

  try {
    const loaded = devEnv.loadDevEnv(tempRoot);

    assert.equal(loaded.mergedEnv.RIVET_WORKFLOWS_HOST_PATH, path.join(tempRoot, 'artifacts', 'workflows'));
    assert.equal(loaded.mergedEnv.RIVET_WORKFLOW_RECORDINGS_HOST_PATH, path.join(tempRoot, 'custom-recordings'));
    assert.equal(loaded.mergedEnv.RIVET_RUNTIME_LIBS_HOST_PATH, path.join(tempRoot, 'artifacts', 'runtime-libraries'));
  } finally {
    if (previousEnvFile == null) {
      delete process.env.RIVET_ENV_FILE;
    } else {
      process.env.RIVET_ENV_FILE = previousEnvFile;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
