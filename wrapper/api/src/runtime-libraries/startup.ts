import fs from 'node:fs';
import path from 'node:path';

import {
  emptyManifest,
  ensureDirectories,
  getRootPath,
  nextReleaseId,
  readActiveRelease,
  readManifest,
  releasesDir,
  writeActiveRelease,
  writeManifest,
  type RuntimeLibraryManifest,
} from './manifest.js';

const MAX_RELEASES_TO_KEEP = 5;

export async function reconcileRuntimeLibraries(): Promise<void> {
  if (!process.env.RIVET_RUNTIME_LIBRARIES_ROOT) {
    console.log('[runtime-libraries] No RIVET_RUNTIME_LIBRARIES_ROOT configured, skipping reconciliation');
    return;
  }

  try {
    ensureDirectories();
  } catch (err) {
    console.error('[runtime-libraries] Failed to create directories:', err);
    return;
  }

  migrateCurrentReleaseIfNeeded();

  const root = getRootPath();
  const manifest = readManifest();
  const activeRelease = readActiveRelease();

  if (!activeRelease && !manifest.activeRelease) {
    console.log('[runtime-libraries] No active release, starting clean');
    return;
  }

  const releaseId = activeRelease ?? manifest.activeRelease;
  if (!releaseId) {
    return;
  }

  const releasePath = path.join(releasesDir(), releaseId);
  const nodeModulesPath = path.join(releasePath, 'node_modules');
  if (!fs.existsSync(releasePath) || !fs.existsSync(nodeModulesPath)) {
    console.warn(`[runtime-libraries] Active release ${releaseId} is missing or corrupt`);

    if (Object.keys(manifest.packages).length > 0) {
      console.warn('[runtime-libraries] Desired packages exist in manifest but active release is missing');
      console.warn('[runtime-libraries] Use the UI to reinstall packages or manually restore the release directory');
    }

    manifest.activeRelease = null;
    writeManifest(manifest);

    try {
      fs.rmSync(path.join(root, 'active-release'), { force: true });
    } catch {
      // ignore if already missing
    }

    return;
  }

  if (manifest.activeRelease !== releaseId) {
    manifest.activeRelease = releaseId;
    manifest.lastSuccessfulRelease = releaseId;
    writeManifest(manifest);
  }

  if (!activeRelease && manifest.activeRelease) {
    writeActiveRelease(manifest.activeRelease);
  }

  console.log(`[runtime-libraries] Active release: ${releaseId} (${Object.keys(manifest.packages).length} packages)`);
  cleanupOldReleases(releaseId);
}

function migrateCurrentReleaseIfNeeded(): void {
  const root = getRootPath();
  const currentPath = path.join(root, 'current');
  const currentNodeModulesPath = path.join(currentPath, 'node_modules');
  if (!fs.existsSync(currentNodeModulesPath) || readActiveRelease()) {
    return;
  }

  const manifest = readManifest();
  const releaseId = nextReleaseId();
  const releasePath = path.join(releasesDir(), releaseId);

  try {
    fs.renameSync(currentPath, releasePath);
    writeActiveRelease(releaseId);

    const nextManifest = buildManifestFromRelease(releasePath, manifest);
    nextManifest.activeRelease = releaseId;
    nextManifest.lastSuccessfulRelease = releaseId;
    writeManifest(nextManifest);

    console.warn(`[runtime-libraries] Migrated current/ layout to legacy release ${releaseId}`);
  } catch (err) {
    console.error('[runtime-libraries] Failed to migrate current/ layout:', err);
  }
}

function buildManifestFromRelease(releasePath: string, previousManifest: RuntimeLibraryManifest): RuntimeLibraryManifest {
  const nextManifest = emptyManifest();
  const packageJsonPath = path.join(releasePath, 'package.json');

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
      nextManifest.packages[name] = {
        name,
        version,
        installedAt: previousManifest.packages[name]?.installedAt,
      };
    }
  } catch (err) {
    console.warn('[runtime-libraries] Failed to rebuild manifest from package.json:', err);
    nextManifest.packages = previousManifest.packages;
  }

  return nextManifest;
}

function cleanupOldReleases(activeReleaseId: string): void {
  try {
    const entries = fs.readdirSync(releasesDir())
      .filter((entry) => /^\d{4}$/.test(entry))
      .sort();

    if (entries.length <= MAX_RELEASES_TO_KEEP) {
      return;
    }

    const toRemove = entries
      .filter((entry) => entry !== activeReleaseId)
      .slice(0, entries.length - MAX_RELEASES_TO_KEEP);

    for (const entry of toRemove) {
      const entryPath = path.join(releasesDir(), entry);
      try {
        fs.rmSync(entryPath, { recursive: true, force: true });
        console.log(`[runtime-libraries] Cleaned up old release: ${entry}`);
      } catch (err) {
        console.warn(`[runtime-libraries] Failed to clean up release ${entry}:`, err);
      }
    }
  } catch {
    // ignore cleanup errors
  }
}
