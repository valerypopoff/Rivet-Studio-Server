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
    const value = trimmed.slice(eqIndex + 1).trim();
    result[key] = value;
  }

  return result;
}

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

const processes = [];

function start(name, command) {
  const child = spawn(command, {
    cwd: rootDir,
    env: mergedEnv,
    shell: true,
    stdio: 'pipe',
  });

  const prefix = `[${name}]`;

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`${prefix} ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`${prefix} ${chunk}`);
  });

  child.on('exit', (code) => {
    process.stderr.write(`${prefix} exited with code ${code ?? 1}\n`);
    shutdown(code ?? 1);
  });

  processes.push(child);
}

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const proc of processes) {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }

  setTimeout(() => process.exit(exitCode), 100);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('API', 'npm --prefix wrapper/api run dev');
start('WEB', 'npm --prefix wrapper/web run dev');
start('EXECUTOR', 'corepack yarn --cwd rivet workspace @ironclad/rivet-app-executor run dev');
