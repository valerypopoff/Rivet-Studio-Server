import fs from 'node:fs';
import path from 'node:path';

import {
  getRootPath,
  ensureDirectories,
  readManifest,
  writeManifest,
  readActiveRelease,
  writeActiveRelease,
  releasesDir,
} from './manifest.js';

const MAX_RELEASES_TO_KEEP = 5;

export async function reconcileRuntimeLibraries(): Promise<void> {
  if (!process.env.RIVET_RUNTIME_LIBRARIES_ROOT) {
    console.log('[runtime-libraries] No RIVET_RUNTIME_LIBRARIES_ROOT configured, skipping reconciliation');
    return;
  }

  const root = getRootPath();

  try {
    ensureDirectories();
  } catch (err) {
    console.error('[runtime-libraries] Failed to create directories:', err);
    return;
  }

  const manifest = readManifest();
  const activeRelease = readActiveRelease();

  if (!activeRelease && !manifest.activeRelease) {
    console.log('[runtime-libraries] No active release, starting clean');
    return;
  }

  const releaseId = activeRelease ?? manifest.activeRelease;
  if (!releaseId) return;

  // Validate the active release directory exists
  const releasePath = path.join(releasesDir(), releaseId);
  const nodeModulesPath = path.join(releasePath, 'node_modules');

  if (!fs.existsSync(releasePath) || !fs.existsSync(nodeModulesPath)) {
    console.warn(`[runtime-libraries] Active release ${releaseId} is missing or corrupt`);

    // If we have a desired package set, we could reconstruct here,
    // but for now just log and continue — the system will fall back
    // to image-baked deps
    if (Object.keys(manifest.packages).length > 0) {
      console.warn('[runtime-libraries] Desired packages exist in manifest but active release is missing');
      console.warn('[runtime-libraries] Use the UI to reinstall packages or manually restore the release directory');
    }

    // Clear the pointer so the fallback kicks in cleanly
    manifest.activeRelease = null;
    writeManifest(manifest);

    try {
      fs.unlinkSync(path.join(root, 'active-release'));
    } catch {
      // ignore if already missing
    }

    return;
  }

  // Sync manifest.activeRelease with the pointer file
  if (manifest.activeRelease !== releaseId) {
    manifest.activeRelease = releaseId;
    manifest.lastSuccessfulRelease = releaseId;
    writeManifest(manifest);
  }

  if (!activeRelease && manifest.activeRelease) {
    writeActiveRelease(manifest.activeRelease);
  }

  console.log(`[runtime-libraries] Active release: ${releaseId} (${Object.keys(manifest.packages).length} packages)`);

  // Clean up old releases
  cleanupOldReleases(releaseId);
}

function cleanupOldReleases(activeReleaseId: string): void {
  try {
    const dir = releasesDir();
    const entries = fs.readdirSync(dir)
      .filter((e) => /^\d{4}$/.test(e))
      .sort();

    if (entries.length <= MAX_RELEASES_TO_KEEP) return;

    const toRemove = entries
      .filter((e) => e !== activeReleaseId)
      .slice(0, entries.length - MAX_RELEASES_TO_KEEP);

    for (const entry of toRemove) {
      const entryPath = path.join(dir, entry);
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
