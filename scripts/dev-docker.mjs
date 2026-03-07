import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const rootDir = process.cwd();
const envPath = path.join(rootDir, '.env.dev');

function parseEnvFile(filePath) {
  const result = {};

  if (!fs.existsSync(filePath)) {
    return result;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function run(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: rootDir,
      env,
      shell: true,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if ((code ?? 1) === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code ?? 1}: ${command}`));
      }
    });
  });
}

const action = process.argv[2] ?? 'dev';
const fileEnv = parseEnvFile(envPath);
const mergedEnv = {
  ...process.env,
  ...fileEnv,
};

if (!Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_WORKSPACE_ROOT')) {
  mergedEnv.RIVET_WORKSPACE_ROOT = rootDir;
}

if (!Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_APP_DATA_ROOT')) {
  mergedEnv.RIVET_APP_DATA_ROOT = path.join(rootDir, '.data', 'rivet-app');
}

if (Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_WORKFLOWS_HOST_PATH')) {
  mergedEnv.RIVET_WORKFLOWS_HOST_PATH = path.resolve(rootDir, fileEnv.RIVET_WORKFLOWS_HOST_PATH);
}

if (!Object.prototype.hasOwnProperty.call(mergedEnv, 'COMPOSE_PARALLEL_LIMIT')) {
  mergedEnv.COMPOSE_PARALLEL_LIMIT = '1';
}

const composeBase = 'docker compose -f ops/docker-compose.dev.yml';

const commandsByAction = {
  build: [`${composeBase} build api executor`],
  up: [`${composeBase} up --build`],
  down: [`${composeBase} down`],
  config: [`${composeBase} config`],
  dev: [`${composeBase} up --build`],
};

const commands = commandsByAction[action];

if (!commands) {
  console.error(`Unknown action: ${action}`);
  console.error('Usage: node scripts/dev-docker.mjs [dev|build|up|down|config]');
  process.exit(1);
}

for (const command of commands) {
  await run(command, mergedEnv);
}
