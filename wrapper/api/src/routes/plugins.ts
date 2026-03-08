import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAppDataRoot, validatePath } from '../security.js';
import { execCommand } from '../utils/exec.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { badRequest } from '../utils/httpError.js';

export const pluginsRouter = Router();

function getPluginDir(pkg: string, tag: string): string {
  return path.join(getAppDataRoot(), 'plugins', `${pkg}-${tag}`);
}

function validatePluginPackagePath(pluginFilesPath: string, candidatePath: string): string {
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

// POST /api/plugins/install-package
pluginsRouter.post('/install-package', asyncHandler(async (req, res) => {
  const { package: pkg, tag } = req.body;
  if (!pkg || !tag) {
    res.status(400).json({ error: 'Missing package or tag' });
    return;
  }

  let log = '';
  const addLog = (msg: string) => { log += msg + '\n'; };

  const pluginDir = getPluginDir(pkg, tag);
  const pluginFilesPath = path.join(pluginDir, 'package');

  let needsReinstall = false;

  try {
    const pkgJsonPath = path.join(pluginFilesPath, 'package.json');
    const completedVersionFile = path.join(pluginFilesPath, '.install_complete_version');

    try {
      await fs.access(pluginFilesPath);

      // Check for updates
      const pkgJsonData = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'));
      const currentVersion = pkgJsonData.version;

      addLog(`Checking for plugin updates: ${pkg}@${tag}`);

      const npmResp = await fetch(`https://registry.npmjs.org/${pkg}/${tag}`);
      if (!npmResp.ok) {
        needsReinstall = true;
      } else {
        const npmData: any = await npmResp.json();
        const latestVersion = npmData.version;

        // Simple version comparison
        if (latestVersion !== currentVersion) {
          addLog(`Plugin update available: ${currentVersion} -> ${latestVersion}`);
          needsReinstall = true;
        }

        // Check node_modules exist
        try {
          await fs.access(path.join(pluginFilesPath, 'node_modules'));
        } catch {
          needsReinstall = true;
        }
      }

      // Check completed version marker
      try {
        const versionMarker = await fs.readFile(completedVersionFile, 'utf-8');
        if (versionMarker.trim() !== tag) {
          needsReinstall = true;
        }
      } catch {
        needsReinstall = true;
      }

      // Skip reinstall if it's a git repo
      try {
        await fs.access(path.join(pluginFilesPath, '.git'));
        needsReinstall = false;
        addLog(`Plugin is a git repository, skipping reinstall: ${pkg}@${tag}`);
      } catch {
        // Not a git repo
      }
    } catch {
      needsReinstall = true;
    }
  } catch {
    needsReinstall = true;
  }

  if (needsReinstall) {
    // Remove existing
    try {
      await fs.rm(pluginDir, { recursive: true, force: true });
    } catch {
      // May not exist
    }

    addLog(`Downloading plugin from NPM: ${pkg}@${tag}`);

    // Fetch package metadata
    const npmResp = await fetch(`https://registry.npmjs.org/${pkg}/${tag}`);
    if (!npmResp.ok) {
      res.status(400).json({ error: `Plugin not found on NPM: ${pkg}@${tag}` });
      return;
    }

    const npmData: any = await npmResp.json();
    const tarballUrl = npmData.dist?.tarball;

    if (!tarballUrl) {
      res.status(400).json({ error: `No tarball URL for plugin: ${pkg}@${tag}` });
      return;
    }

    addLog(`Downloading tarball: ${tarballUrl}`);

    // Download tarball
    const tarballResp = await fetch(tarballUrl);
    if (!tarballResp.ok) {
      res.status(400).json({ error: `Failed to download tarball: ${tarballUrl}` });
      return;
    }

    const tarballBuffer = Buffer.from(await tarballResp.arrayBuffer());

    // Create plugin dir and write tarball
    await fs.mkdir(pluginDir, { recursive: true });
    const tarPath = path.join(pluginDir, 'package.tgz');
    await fs.writeFile(tarPath, tarballBuffer);

    addLog('Extracting tarball...');

    // Extract tarball
    const tar = await import('tar');
    await tar.extract({
      file: tarPath,
      cwd: pluginDir,
    });

    // Install dependencies
    const pkgJsonPath = path.join(pluginFilesPath, 'package.json');
    let hasPackageJson = true;
    let skipInstall = false;
    try {
      const pkgJsonData = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'));
      skipInstall = Boolean(pkgJsonData?.rivet?.skipInstall);
    } catch {
      hasPackageJson = false;
      addLog('No package.json found or install skipped');
    }

    if (hasPackageJson && !skipInstall) {
      addLog('Installing NPM dependencies...');
      const installResult = await execCommand('pnpm', ['install', '--prod', '--ignore-scripts'], {
        cwd: pluginFilesPath,
        timeoutMs: 120_000,
      });

      if (installResult.code !== 0) {
        throw new Error(log + '\n' + installResult.stderr);
      }
      addLog('Installed NPM dependencies');
    } else if (hasPackageJson) {
      addLog('Skipping NPM dependencies install');
    }

    // Write version marker
    const completedVersionFile = path.join(pluginFilesPath, '.install_complete_version');
    await fs.writeFile(completedVersionFile, tag, 'utf-8');
  }

  addLog(`Plugin ready: ${pkg}@${tag}`);
  res.json({ success: true, log });
}));

// POST /api/plugins/load-package-main
pluginsRouter.post('/load-package-main', asyncHandler(async (req, res) => {
  const { package: pkg, tag } = req.body;
  if (!pkg || !tag) {
    res.status(400).json({ error: 'Missing package or tag' });
    return;
  }

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

