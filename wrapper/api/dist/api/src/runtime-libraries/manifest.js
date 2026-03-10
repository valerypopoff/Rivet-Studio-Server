import fs from 'node:fs';
import path from 'node:path';
function getRuntimeLibrariesRoot() {
    return process.env.RIVET_RUNTIME_LIBRARIES_ROOT ?? '/data/runtime-libraries';
}
export function getRootPath() {
    return getRuntimeLibrariesRoot();
}
function manifestPath() {
    return path.join(getRuntimeLibrariesRoot(), 'manifest.json');
}
function activeReleasePath() {
    return path.join(getRuntimeLibrariesRoot(), 'active-release');
}
export function releasesDir() {
    return path.join(getRuntimeLibrariesRoot(), 'releases');
}
export function stagingDir() {
    return path.join(getRuntimeLibrariesRoot(), 'staging');
}
export function ensureDirectories() {
    const root = getRuntimeLibrariesRoot();
    fs.mkdirSync(path.join(root, 'releases'), { recursive: true });
    fs.mkdirSync(path.join(root, 'staging'), { recursive: true });
}
export function emptyManifest() {
    return {
        packages: {},
        activeRelease: null,
        lastSuccessfulRelease: null,
        updatedAt: new Date().toISOString(),
    };
}
export function readManifest() {
    try {
        const raw = fs.readFileSync(manifestPath(), 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return emptyManifest();
    }
}
export function writeManifest(manifest) {
    manifest.updatedAt = new Date().toISOString();
    const tmp = manifestPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(tmp, manifestPath());
}
export function readActiveRelease() {
    try {
        const id = fs.readFileSync(activeReleasePath(), 'utf8').trim();
        return id || null;
    }
    catch {
        return null;
    }
}
export function writeActiveRelease(releaseId) {
    const tmp = activeReleasePath() + '.tmp';
    fs.writeFileSync(tmp, releaseId, 'utf8');
    fs.renameSync(tmp, activeReleasePath());
}
export function nextReleaseId() {
    const dir = releasesDir();
    try {
        const entries = fs.readdirSync(dir).filter((entry) => /^\d{4}$/.test(entry)).sort();
        if (entries.length === 0) {
            return '0001';
        }
        const last = parseInt(entries[entries.length - 1], 10);
        return String(last + 1).padStart(4, '0');
    }
    catch {
        return '0001';
    }
}
export function activeReleaseNodeModulesPath() {
    const releaseId = readActiveRelease();
    if (!releaseId) {
        return null;
    }
    const nodeModulesPath = path.join(releasesDir(), releaseId, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
        return null;
    }
    return nodeModulesPath;
}
