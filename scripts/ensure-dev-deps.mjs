import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const rivetDir = path.join(rootDir, 'rivet');
const rivetRepoUrl = process.env.RIVET_REPO_URL || 'https://github.com/valerypopoff/rivet2.0.git';
const rivetRepoRef = process.env.RIVET_REPO_REF || process.env.RIVET_BRANCH || 'main';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const corepackCmd = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const gitCmd = process.platform === 'win32' ? 'git.exe' : 'git';

function quoteArg(arg) {
  if (/\s|"/.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}

function run(command, args, cwd = rootDir) {
  const commandLine = [command, ...args.map(quoteArg)].join(' ');
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);

  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: useShell,
  });

  if (result.error) {
    console.error(`[predev] Failed to run command: ${commandLine}`);
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function exists(relPath) {
  return fs.existsSync(path.join(rootDir, relPath));
}

function isLinkedTo(relPath, targetRelPath) {
  const fullPath = path.join(rootDir, relPath);
  const targetPath = path.join(rootDir, targetRelPath);

  if (!fs.existsSync(fullPath) || !fs.existsSync(targetPath)) {
    return false;
  }

  try {
    return fs.realpathSync(fullPath) === fs.realpathSync(targetPath);
  } catch {
    return false;
  }
}

function hasExpectedApiRivetLink(packageName, sourcePackageRelPath) {
  const packageRelPath = `wrapper/api/node_modules/@ironclad/${packageName}`;
  const overlayRelPath = `wrapper/api/node_modules/.rivet-package-links/${packageName}`;
  const sourceDistRelPath = path.join(sourcePackageRelPath, 'dist');

  return (
    isLinkedTo(packageRelPath, overlayRelPath) &&
    isLinkedTo(path.join(overlayRelPath, 'dist'), sourceDistRelPath) &&
    isLinkedTo(path.join(overlayRelPath, 'node_modules'), 'rivet/node_modules')
  );
}

function hasExpectedRivetWorkspace() {
  const requiredEntries = [
    'rivet/package.json',
    'rivet/.yarnrc.yml',
    'rivet/packages/core/package.json',
    'rivet/packages/node/package.json',
  ];

  return requiredEntries.every((relPath) => exists(relPath));
}

function ensureRivetRepo() {
  if (fs.existsSync(path.join(rivetDir, '.git'))) {
    return;
  }

  if (fs.existsSync(rivetDir)) {
    const contents = fs.readdirSync(rivetDir);

    if (contents.length > 0) {
      if (hasExpectedRivetWorkspace()) {
        console.log('[predev] Using existing rivet/ snapshot.');
        return;
      }

      console.error('[predev] Expected rivet/ to be absent, a Git checkout, or a valid upstream snapshot.');
      console.error('[predev] The existing rivet/ directory is populated but does not match the expected upstream workspace layout.');
      console.error('[predev] Remove or rename it, then run the command again.');
      process.exit(1);
    }
  }

  console.log(`[predev] Cloning rivet from ${rivetRepoUrl} (${rivetRepoRef})`);
  run(gitCmd, ['clone', '--branch', rivetRepoRef, rivetRepoUrl, 'rivet']);
}

ensureRivetRepo();

const needsApiDeps = !exists('wrapper/api/node_modules/.bin/tsx');
const needsWebDeps =
  !exists('wrapper/web/node_modules/.bin/vite') ||
  !exists('wrapper/web/node_modules/.bin/playwright');
const needsRivetDeps =
  !exists('rivet/.pnp.cjs') ||
  !exists('rivet/.yarn/unplugged') ||
  !exists('rivet/.yarn/unplugged/esbuild-npm-0.19.5-107ce8536d/node_modules/esbuild');
const needsRivetCoreBuild = !exists('rivet/packages/core/dist/esm/index.js');
const needsRivetNodeBuild = !exists('rivet/packages/node/dist/esm/index.js');
const needsApiRivetLinks =
  !hasExpectedApiRivetLink('rivet-core', 'rivet/packages/core') ||
  !hasExpectedApiRivetLink('rivet-node', 'rivet/packages/node');

if (
  !needsApiDeps &&
  !needsWebDeps &&
  !needsRivetDeps &&
  !needsRivetCoreBuild &&
  !needsRivetNodeBuild &&
  !needsApiRivetLinks
) {
  process.exit(0);
}

console.log('[predev] Installing missing dependencies...');

if (needsApiDeps) {
  console.log('[predev] Installing wrapper/api dependencies');
  run(npmCmd, ['--prefix', 'wrapper/api', 'install']);
}

if (needsWebDeps) {
  console.log('[predev] Installing wrapper/web dependencies');
  run(npmCmd, ['--prefix', 'wrapper/web', 'install', '--legacy-peer-deps']);
}

if (needsRivetDeps) {
  console.log('[predev] Installing rivet dependencies with Yarn via Corepack');
  run(corepackCmd, ['yarn', 'install'], path.join(rootDir, 'rivet'));
}

if (needsRivetCoreBuild) {
  console.log('[predev] Building @ironclad/rivet-core');
  run(corepackCmd, ['yarn', 'workspace', '@ironclad/rivet-core', 'run', 'build'], path.join(rootDir, 'rivet'));
}

if (needsRivetNodeBuild) {
  console.log('[predev] Building @ironclad/rivet-node');
  run(corepackCmd, ['yarn', 'workspace', '@ironclad/rivet-node', 'run', 'build'], path.join(rootDir, 'rivet'));
}

if (needsApiRivetLinks || needsApiDeps || needsRivetCoreBuild || needsRivetNodeBuild) {
  console.log('[predev] Linking wrapper/api to local Rivet packages');
  run(process.execPath, ['scripts/link-rivet-node-package.mjs']);
}

console.log('[predev] Dependencies are ready.');
