import fs from 'node:fs';
import path from 'node:path';

export interface RuntimeLibraryEntry {
  name: string;
  version: string;
  installedAt?: string;
}

export interface RuntimeLibraryManifest {
  packages: Record<string, RuntimeLibraryEntry>;
  activeRelease: string | null;
  lastSuccessfulRelease: string | null;
  updatedAt: string;
}

function getRuntimeLibrariesRoot(): string {
  return process.env.RIVET_RUNTIME_LIBRARIES_ROOT ?? '/data/runtime-libraries';
}

export function getRootPath(): string {
  return getRuntimeLibrariesRoot();
}

function manifestPath(): string {
  return path.join(getRuntimeLibrariesRoot(), 'manifest.json');
}

function activeReleasePath(): string {
  return path.join(getRuntimeLibrariesRoot(), 'active-release');
}

export function releasesDir(): string {
  return path.join(getRuntimeLibrariesRoot(), 'releases');
}

export function stagingDir(): string {
  return path.join(getRuntimeLibrariesRoot(), 'staging');
}

export function ensureDirectories(): void {
  const root = getRuntimeLibrariesRoot();
  fs.mkdirSync(path.join(root, 'releases'), { recursive: true });
  fs.mkdirSync(path.join(root, 'staging'), { recursive: true });
}

export function emptyManifest(): RuntimeLibraryManifest {
  return {
    packages: {},
    activeRelease: null,
    lastSuccessfulRelease: null,
    updatedAt: new Date().toISOString(),
  };
}

export function readManifest(): RuntimeLibraryManifest {
  try {
    const raw = fs.readFileSync(manifestPath(), 'utf8');
    return JSON.parse(raw) as RuntimeLibraryManifest;
  } catch {
    return emptyManifest();
  }
}

export function writeManifest(manifest: RuntimeLibraryManifest): void {
  manifest.updatedAt = new Date().toISOString();
  const tmp = manifestPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  fs.renameSync(tmp, manifestPath());
}

export function readActiveRelease(): string | null {
  try {
    const id = fs.readFileSync(activeReleasePath(), 'utf8').trim();
    return id || null;
  } catch {
    return null;
  }
}

export function writeActiveRelease(releaseId: string): void {
  const tmp = activeReleasePath() + '.tmp';
  fs.writeFileSync(tmp, releaseId, 'utf8');
  fs.renameSync(tmp, activeReleasePath());
}

export function nextReleaseId(): string {
  const dir = releasesDir();
  try {
    const entries = fs.readdirSync(dir).filter((e) => /^\d{4}$/.test(e)).sort();
    if (entries.length === 0) return '0001';
    const last = parseInt(entries[entries.length - 1], 10);
    return String(last + 1).padStart(4, '0');
  } catch {
    return '0001';
  }
}

export function activeReleaseNodeModulesPath(): string | null {
  const id = readActiveRelease();
  if (!id) return null;
  const nmPath = path.join(releasesDir(), id, 'node_modules');
  if (!fs.existsSync(nmPath)) return null;
  return nmPath;
}
