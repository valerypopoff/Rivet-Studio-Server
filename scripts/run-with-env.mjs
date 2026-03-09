import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseEnvFile } from './lib/env.mjs';

const rootDir = process.cwd();
const envPath = path.join(rootDir, '.env.dev');

const command = process.argv.slice(2).join(' ').trim();
if (!command) {
  console.error('Usage: node scripts/run-with-env.mjs "<command>"');
  process.exit(1);
}

const fileEnv = parseEnvFile(envPath);
const mergedEnv = {
  ...process.env,
  ...fileEnv,
};

const executorNodeModulesPath = path.join(rootDir, 'wrapper', 'executor', 'node_modules');

if (!Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_WORKSPACE_ROOT')) {
  mergedEnv.RIVET_WORKSPACE_ROOT = rootDir;
}

if (!Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_APP_DATA_ROOT')) {
  mergedEnv.RIVET_APP_DATA_ROOT = path.join(rootDir, '.data', 'rivet-app');
}

mergedEnv.NODE_PATH = [executorNodeModulesPath, mergedEnv.NODE_PATH].filter(Boolean).join(path.delimiter);

const child = spawn(command, {
  cwd: rootDir,
  env: mergedEnv,
  shell: true,
  stdio: 'inherit',
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
