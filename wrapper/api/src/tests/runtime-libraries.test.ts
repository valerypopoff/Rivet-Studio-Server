import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const runtimeLibrariesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-libraries-'));
process.env.RIVET_RUNTIME_LIBRARIES_ROOT = runtimeLibrariesRoot;

const manifest = await import('../runtime-libraries/manifest.js');
const startup = await import('../runtime-libraries/startup.js');
const filesystemBackend = await import('../runtime-libraries/filesystem-backend.js');
const runtimeLibrariesConfig = await import('../runtime-libraries/config.js');

async function resetRuntimeLibrariesRoot() {
  await fs.rm(runtimeLibrariesRoot, { recursive: true, force: true });
  await fs.mkdir(runtimeLibrariesRoot, { recursive: true });
}

test.beforeEach(async () => {
  await resetRuntimeLibrariesRoot();
});

test('readManifest normalizes invalid manifest content', async () => {
  await fs.writeFile(
    path.join(runtimeLibrariesRoot, 'manifest.json'),
    JSON.stringify({
      packages: {
        valid: { name: 'wrong-name', version: '^1.0.0', installedAt: '2026-01-01T00:00:00.000Z' },
        missingVersion: { name: 'missingVersion' },
        arrayEntry: [],
      },
      updatedAt: '2026-02-02T00:00:00.000Z',
      activeReleaseId: 'release-123',
    }),
    'utf8',
  );

  assert.deepEqual(manifest.readManifest(), {
    packages: {
      valid: {
        name: 'valid',
        version: '^1.0.0',
        installedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    updatedAt: '2026-02-02T00:00:00.000Z',
    activeReleaseId: 'release-123',
  });
});

test('reconcileRuntimeLibraries clears stale manifest state when no active runtime set exists', async () => {
  await fs.writeFile(
    path.join(runtimeLibrariesRoot, 'manifest.json'),
    JSON.stringify({
      packages: {
        lodash: {
          name: 'lodash',
          version: '^4.17.21',
          installedAt: '2026-03-01T00:00:00.000Z',
        },
      },
      updatedAt: '2026-03-01T00:00:00.000Z',
    }),
    'utf8',
  );

  await startup.reconcileRuntimeLibraries();

  assert.deepEqual(manifest.readManifest().packages, {});
});

test('reconcileRuntimeLibraries preserves manifest when active runtime set exists', async () => {
  const currentPath = path.join(runtimeLibrariesRoot, 'current');
  await fs.mkdir(path.join(currentPath, 'node_modules'), { recursive: true });

  const packages = {
    lodash: {
      name: 'lodash',
      version: '^4.17.21',
      installedAt: '2026-03-01T00:00:00.000Z',
    },
  };

  await fs.writeFile(
    path.join(runtimeLibrariesRoot, 'manifest.json'),
    JSON.stringify({ packages, updatedAt: '2026-03-01T00:00:00.000Z' }),
    'utf8',
  );

  await startup.reconcileRuntimeLibraries();

  const result = manifest.readManifest();
  assert.deepEqual(result.packages, packages);
});

test('readManifest returns empty manifest when file does not exist', () => {
  const result = manifest.readManifest();
  assert.deepEqual(result.packages, {});
  assert.ok(result.updatedAt);
});

test('readManifest returns empty manifest when file contains invalid JSON', async () => {
  await fs.writeFile(
    path.join(runtimeLibrariesRoot, 'manifest.json'),
    'not-json',
    'utf8',
  );

  const result = manifest.readManifest();
  assert.deepEqual(result.packages, {});
});

test('writeManifest writes atomically and can be read back', () => {
  manifest.ensureDirectories();
  const packages = {
    express: { name: 'express', version: '^4.18.0', installedAt: '2026-01-01T00:00:00.000Z' },
  };

  manifest.writeManifest({ packages, updatedAt: '', activeReleaseId: 'release-456' });

  const result = manifest.readManifest();
  assert.deepEqual(result.packages, packages);
  assert.equal(result.activeReleaseId, 'release-456');
  assert.ok(result.updatedAt, 'updatedAt should be set by writeManifest');
});

test('writeManifest recreates missing runtime-library directories before writing', async () => {
  await fs.rm(runtimeLibrariesRoot, { recursive: true, force: true });

  manifest.writeManifest({
    packages: {},
    updatedAt: '',
    activeReleaseId: 'release-recreated',
  });

  const result = manifest.readManifest();
  assert.equal(result.activeReleaseId, 'release-recreated');
  const rootStat = await fs.stat(runtimeLibrariesRoot);
  assert.ok(rootStat.isDirectory());
});

test('normalizeManifest strips entries with empty version strings', () => {
  const result = manifest.normalizeManifest({
    packages: {
      good: { version: '1.0.0' },
      bad: { version: '' },
    },
  });

  assert.ok(result.packages.good);
  assert.equal(result.packages.bad, undefined);
});

test('ensureDirectories creates root and staging dirs', async () => {
  await fs.rm(runtimeLibrariesRoot, { recursive: true, force: true });
  manifest.ensureDirectories();

  const rootStat = await fs.stat(runtimeLibrariesRoot);
  const stagingStat = await fs.stat(path.join(runtimeLibrariesRoot, 'staging'));
  assert.ok(rootStat.isDirectory());
  assert.ok(stagingStat.isDirectory());
});

test('currentNodeModulesPath returns null when no current directory exists', () => {
  assert.equal(manifest.currentNodeModulesPath(), null);
});

test('currentNodeModulesPath returns path when node_modules exists', async () => {
  const currentPath = path.join(runtimeLibrariesRoot, 'current');
  await fs.mkdir(path.join(currentPath, 'node_modules'), { recursive: true });

  const result = manifest.currentNodeModulesPath();
  assert.ok(result);
  assert.ok(result.endsWith('node_modules'));
});

test('filesystem backend reports no active libraries for an empty active release', async () => {
  const currentPath = path.join(runtimeLibrariesRoot, 'current');
  await fs.mkdir(path.join(currentPath, 'node_modules'), { recursive: true });

  const backend = filesystemBackend.createFilesystemRuntimeLibrariesBackend();
  const state = await backend.getState();

  assert.equal(state.hasActiveLibraries, false);
  assert.deepEqual(state.packages, {});
  assert.equal(state.replicaReadiness, null);
});

test('runtime-library mode follows the shared storage mode env', () => {
  const originalStorageMode = process.env.RIVET_STORAGE_MODE;

  try {
    process.env.RIVET_STORAGE_MODE = 'managed';
    assert.equal(runtimeLibrariesConfig.getRuntimeLibrariesBackendMode(), 'managed');

    delete process.env.RIVET_STORAGE_MODE;
    assert.equal(runtimeLibrariesConfig.getRuntimeLibrariesBackendMode(), 'filesystem');
  } finally {
    if (originalStorageMode === undefined) {
      delete process.env.RIVET_STORAGE_MODE;
    } else {
      process.env.RIVET_STORAGE_MODE = originalStorageMode;
    }
  }
});

test('runtime-library config rejects retired alias env names', () => {
  const originalStorageBackend = process.env.RIVET_STORAGE_BACKEND;

  try {
    process.env.RIVET_STORAGE_BACKEND = 'managed';
    assert.throws(
      () => runtimeLibrariesConfig.getRuntimeLibrariesBackendMode(),
      /Retired environment variable/,
    );
  } finally {
    if (originalStorageBackend === undefined) {
      delete process.env.RIVET_STORAGE_BACKEND;
    } else {
      process.env.RIVET_STORAGE_BACKEND = originalStorageBackend;
    }
  }
});
