import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const corepackCmd = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';

function quoteArg(arg) {
  if (/\s|"/.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}

function run(command, args, cwd = rootDir) {
  const commandLine = [command, ...args.map(quoteArg)].join(' ');

  const result = spawnSync(commandLine, {
    cwd,
    stdio: 'inherit',
    shell: true,
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

const needsApiDeps = !exists('wrapper/api/node_modules/.bin/tsx');
const needsWebDeps = !exists('wrapper/web/node_modules/.bin/vite');
const needsRivetDeps =
  !exists('rivet/.pnp.cjs') ||
  !exists('rivet/.yarn/unplugged') ||
  !exists('rivet/.yarn/unplugged/esbuild-npm-0.19.5-107ce8536d/node_modules/esbuild');
const needsRivetCoreBuild = !exists('rivet/packages/core/dist/esm/index.js');
const needsRivetNodeBuild = !exists('rivet/packages/node/dist/esm/index.js');

if (!needsApiDeps && !needsWebDeps && !needsRivetDeps && !needsRivetCoreBuild && !needsRivetNodeBuild) {
  process.exit(0);
}

console.log('[predev] Installing missing dependencies...');

if (needsApiDeps) {
  console.log('[predev] Installing wrapper/api dependencies');
  run(npmCmd, ['--prefix', 'wrapper/api', 'install']);
}

if (needsWebDeps) {
  console.log('[predev] Installing wrapper/web dependencies');
  run(npmCmd, ['--prefix', 'wrapper/web', 'install']);
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

console.log('[predev] Dependencies are ready.');
