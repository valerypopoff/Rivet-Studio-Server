import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { getAppDataRoot, validatePath } from '../security.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { badRequest, createHttpError } from '../utils/httpError.js';
import { exec } from '../utils/exec.js';
export const pluginsRouter = Router();
const pluginRequestSchema = z.object({
    package: z.string().min(1, 'package is required'),
    tag: z.string().min(1, 'tag is required'),
});
function getPluginDir(pkg, tag) {
    return path.join(getAppDataRoot(), 'plugins', `${pkg}-${tag}`);
}
function validatePluginPackagePath(pluginFilesPath, candidatePath) {
    const resolvedPluginRoot = path.resolve(pluginFilesPath);
    const resolvedCandidate = path.resolve(candidatePath);
    const isInsidePluginRoot = process.platform === 'win32'
        ? resolvedCandidate.toLowerCase() === resolvedPluginRoot.toLowerCase() || resolvedCandidate.toLowerCase().startsWith(`${resolvedPluginRoot.toLowerCase()}${path.sep}`)
        : resolvedCandidate === resolvedPluginRoot || resolvedCandidate.startsWith(`${resolvedPluginRoot}${path.sep}`);
    if (!isInsidePluginRoot) {
        throw badRequest('Plugin main field must resolve inside the extracted package');
    }
    return validatePath(resolvedCandidate);
}
async function checkPluginForUpdate(pkg, tag, addLog) {
    const pluginDir = getPluginDir(pkg, tag);
    const pluginFilesPath = path.join(pluginDir, 'package');
    const pkgJsonPath = path.join(pluginFilesPath, 'package.json');
    const completedVersionFile = path.join(pluginFilesPath, '.install_complete_version');
    try {
        await fs.access(pluginFilesPath);
    }
    catch {
        return true;
    }
    try {
        await fs.access(path.join(pluginFilesPath, '.git'));
        addLog(`Plugin is a git repository, skipping reinstall: ${pkg}@${tag}`);
        return false;
    }
    catch {
        // not a git checkout
    }
    addLog(`Checking for plugin updates: ${pkg}@${tag}`);
    try {
        const pkgJsonData = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'));
        const npmResp = await fetch(`https://registry.npmjs.org/${pkg}/${tag}`);
        if (!npmResp.ok) {
            return true;
        }
        const npmData = await npmResp.json();
        if (npmData.version !== pkgJsonData.version) {
            addLog(`Plugin update available: ${pkgJsonData.version ?? '(unknown)'} -> ${npmData.version ?? '(unknown)'}`);
            return true;
        }
        await fs.access(path.join(pluginFilesPath, 'node_modules'));
        const versionMarker = await fs.readFile(completedVersionFile, 'utf-8');
        return versionMarker.trim() !== tag;
    }
    catch {
        return true;
    }
}
async function downloadAndExtractPlugin(pkg, tag, addLog) {
    const pluginDir = getPluginDir(pkg, tag);
    const pluginFilesPath = path.join(pluginDir, 'package');
    await fs.rm(pluginDir, { recursive: true, force: true });
    addLog(`Downloading plugin from NPM: ${pkg}@${tag}`);
    const npmResp = await fetch(`https://registry.npmjs.org/${pkg}/${tag}`);
    if (!npmResp.ok) {
        throw badRequest(`Plugin not found on NPM: ${pkg}@${tag}`);
    }
    const npmData = await npmResp.json();
    const tarballUrl = npmData.dist?.tarball;
    if (!tarballUrl) {
        throw badRequest(`No tarball URL for plugin: ${pkg}@${tag}`);
    }
    addLog(`Downloading tarball: ${tarballUrl}`);
    const tarballResp = await fetch(tarballUrl);
    if (!tarballResp.ok) {
        throw badRequest(`Failed to download tarball: ${tarballUrl}`);
    }
    const tarballBuffer = Buffer.from(await tarballResp.arrayBuffer());
    await fs.mkdir(pluginDir, { recursive: true });
    const tarPath = path.join(pluginDir, 'package.tgz');
    await fs.writeFile(tarPath, tarballBuffer);
    addLog('Extracting tarball...');
    const tar = await import('tar');
    await tar.extract({
        file: tarPath,
        cwd: pluginDir,
    });
    const pkgJsonPath = path.join(pluginFilesPath, 'package.json');
    let hasPackageJson = true;
    let skipInstall = false;
    try {
        const pkgJsonData = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'));
        skipInstall = Boolean(pkgJsonData?.rivet?.skipInstall);
    }
    catch {
        hasPackageJson = false;
        addLog('No package.json found or install skipped');
    }
    if (hasPackageJson && !skipInstall) {
        addLog('Installing NPM dependencies...');
        const installResult = await exec('pnpm', ['install', '--prod', '--ignore-scripts'], {
            cwd: pluginFilesPath,
            timeoutMs: 120_000,
        });
        if (installResult.code !== 0) {
            throw new Error(`${installResult.stderr}\n${installResult.stdout}`.trim());
        }
        addLog('Installed NPM dependencies');
    }
    else if (hasPackageJson) {
        addLog('Skipping NPM dependencies install');
    }
    await fs.writeFile(path.join(pluginFilesPath, '.install_complete_version'), tag, 'utf-8');
}
function appendInstallLog(error, log) {
    const message = error instanceof Error ? error.message : String(error);
    const formatted = `${log}${message}`.trim();
    const status = error?.status;
    if (typeof status === 'number') {
        return createHttpError(status, formatted);
    }
    return createHttpError(400, formatted);
}
pluginsRouter.post('/install-package', validateBody(pluginRequestSchema), asyncHandler(async (req, res) => {
    const { package: pkg, tag } = req.body;
    let log = '';
    const addLog = (message) => {
        log += `${message}\n`;
    };
    if (await checkPluginForUpdate(pkg, tag, addLog)) {
        try {
            await downloadAndExtractPlugin(pkg, tag, addLog);
        }
        catch (error) {
            throw appendInstallLog(error, log);
        }
    }
    addLog(`Plugin ready: ${pkg}@${tag}`);
    res.json({ success: true, log });
}));
pluginsRouter.post('/load-package-main', validateBody(pluginRequestSchema), asyncHandler(async (req, res) => {
    const { package: pkg, tag } = req.body;
    const pluginDir = getPluginDir(pkg, tag);
    const pluginFilesPath = path.join(pluginDir, 'package');
    const pkgJsonPath = path.join(pluginFilesPath, 'package.json');
    const pkgJsonData = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'));
    const main = pkgJsonData.main;
    if (!main) {
        res.status(400).json({ error: `No main field in package.json for ${pkg}@${tag}` });
        return;
    }
    const mainPath = path.join(pluginFilesPath, main);
    const safePath = validatePluginPackagePath(pluginFilesPath, mainPath);
    const contents = await fs.readFile(safePath, 'utf-8');
    res.json({ contents });
}));
