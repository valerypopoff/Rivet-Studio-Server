import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { loadDevEnv } from './lib/dev-env.mjs';

const rootDir = process.cwd();
let composeBase = 'docker compose -f ops/docker-compose.dev.yml';
const diagnosticServices = 'api web executor proxy';
let envFileLabel = '.env';

function run(command, env, options = {}) {
  const allowFailure = options.allowFailure === true;
  const stdio = options.stdio ?? 'inherit';

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: rootDir,
      env,
      shell: true,
      stdio,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      const exitCode = code == null ? 1 : code;
      if (exitCode === 0 || allowFailure) {
        resolve(exitCode);
      } else {
        reject(new Error(`Command failed with exit code ${exitCode}: ${command}`));
      }
    });
  });
}

function runCapture(command, env, options = {}) {
  const allowFailure = options.allowFailure === true;

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: rootDir,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      const exitCode = code == null ? 1 : code;
      if (exitCode === 0 || allowFailure) {
        resolve({ exitCode, stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${exitCode}: ${command}\n${stderr}`.trim()));
      }
    });
  });
}

async function printFailureDiagnostics(env) {
  console.error('[dev-docker] Docker compose reported a failure. Collecting container status and recent logs...');
  await run(`${composeBase} ps`, env, { allowFailure: true });
  await run(`${composeBase} logs --tail=120 ${diagnosticServices}`, env, { allowFailure: true });
}

function assertValidPort(value, fallback) {
  const parsed = parseInt(value == null ? '' : value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }

  return parsed;
}

function readNormalizedEnv(env, ...names) {
  for (const name of names) {
    const value = String(env[name] ?? '').trim().toLowerCase();
    if (value) {
      return value;
    }
  }

  return '';
}

const retiredEnvReplacements = {
  RIVET_STORAGE_BACKEND: 'RIVET_STORAGE_MODE',
  RIVET_WORKFLOWS_STORAGE_BACKEND: 'RIVET_STORAGE_MODE',
  RIVET_DATABASE_URL: 'RIVET_DATABASE_CONNECTION_STRING',
  RIVET_WORKFLOWS_DATABASE_MODE: 'RIVET_DATABASE_MODE',
  RIVET_WORKFLOWS_DATABASE_URL: 'RIVET_DATABASE_CONNECTION_STRING',
  RIVET_WORKFLOWS_DATABASE_CONNECTION_STRING: 'RIVET_DATABASE_CONNECTION_STRING',
  RIVET_WORKFLOWS_DATABASE_SSL_MODE: 'RIVET_DATABASE_SSL_MODE',
  RIVET_OBJECT_STORAGE_BUCKET: 'RIVET_STORAGE_BUCKET',
  RIVET_OBJECT_STORAGE_REGION: 'RIVET_STORAGE_REGION',
  RIVET_OBJECT_STORAGE_ENDPOINT: 'RIVET_STORAGE_ENDPOINT',
  RIVET_OBJECT_STORAGE_ACCESS_KEY_ID: 'RIVET_STORAGE_ACCESS_KEY_ID',
  RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY: 'RIVET_STORAGE_ACCESS_KEY',
  RIVET_STORAGE_SECRET_ACCESS_KEY: 'RIVET_STORAGE_ACCESS_KEY',
  RIVET_OBJECT_STORAGE_PREFIX: 'RIVET_STORAGE_PREFIX',
  RIVET_OBJECT_STORAGE_FORCE_PATH_STYLE: 'RIVET_STORAGE_FORCE_PATH_STYLE',
  RIVET_WORKFLOWS_STORAGE_URL: 'RIVET_STORAGE_URL',
  RIVET_WORKFLOWS_STORAGE_BUCKET: 'RIVET_STORAGE_BUCKET',
  RIVET_WORKFLOWS_STORAGE_REGION: 'RIVET_STORAGE_REGION',
  RIVET_WORKFLOWS_STORAGE_ENDPOINT: 'RIVET_STORAGE_ENDPOINT',
  RIVET_WORKFLOWS_STORAGE_ACCESS_KEY_ID: 'RIVET_STORAGE_ACCESS_KEY_ID',
  RIVET_WORKFLOWS_STORAGE_SECRET_ACCESS_KEY: 'RIVET_STORAGE_ACCESS_KEY',
  RIVET_WORKFLOWS_STORAGE_ACCESS_KEY: 'RIVET_STORAGE_ACCESS_KEY',
  RIVET_WORKFLOWS_STORAGE_PREFIX: 'RIVET_STORAGE_PREFIX',
  RIVET_WORKFLOWS_STORAGE_FORCE_PATH_STYLE: 'RIVET_STORAGE_FORCE_PATH_STYLE',
  RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS: 'RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS',
};

function assertNoRetiredEnv(env) {
  const activeRetired = Object.entries(retiredEnvReplacements)
    .filter(([name]) => String(env[name] ?? '').trim())
    .map(([name, replacement]) => `${name} -> ${replacement}`);

  if (activeRetired.length === 0) {
    return;
  }

  throw new Error(
    `[dev-docker] Retired environment variable(s) detected in ${envFileLabel}: ${activeRetired.join(', ')}. ` +
    'Update the env file to the canonical names before starting the stack.',
  );
}

function enableManagedWorkflowProfileIfNeeded(env) {
  const storageBackend = readNormalizedEnv(env, 'RIVET_STORAGE_MODE');
  const databaseMode = readNormalizedEnv(env, 'RIVET_DATABASE_MODE');
  if (storageBackend !== 'managed' || databaseMode !== 'local-docker') {
    return;
  }

  const existingProfiles = String(env.COMPOSE_PROFILES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!existingProfiles.includes('workflow-managed')) {
    existingProfiles.push('workflow-managed');
    env.COMPOSE_PROFILES = existingProfiles.join(',');
  }
}

function ensurePortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        reject(new Error(`[dev-docker] Host port ${port} is already in use. Set RIVET_PORT in ${envFileLabel} to a free port, or stop the process currently listening on ${port}.`));
        return;
      }

      reject(error);
    });

    server.once('listening', () => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve();
      });
    });

    server.listen(port, '0.0.0.0');
  });
}

async function isComposeServiceRunning(service, env) {
  const result = await runCapture(`${composeBase} ps --status running --services ${service}`, env, { allowFailure: true });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(service);
}

async function main() {
  const action = process.argv[2] == null ? 'dev' : process.argv[2];
  const { mergedEnv, envPath, hasEnvFile } = loadDevEnv(rootDir);

  envFileLabel = path.basename(envPath);
  if (hasEnvFile) {
    const relativeEnvPath = path.relative(rootDir, envPath) || envFileLabel;
    composeBase = `docker compose --env-file "${relativeEnvPath}" -f ops/docker-compose.dev.yml`;
  }

  if (!Object.prototype.hasOwnProperty.call(mergedEnv, 'COMPOSE_PARALLEL_LIMIT')) {
    mergedEnv.COMPOSE_PARALLEL_LIMIT = '1';
  }

  assertNoRetiredEnv(mergedEnv);
  enableManagedWorkflowProfileIfNeeded(mergedEnv);

  const waitTimeoutSeconds = parseInt(mergedEnv.RIVET_DOCKER_WAIT_TIMEOUT ?? '900', 10);
  const proxyPort = assertValidPort(mergedEnv.RIVET_PORT, 8080);

  const commandsByAction = {
    build: [`${composeBase} build api executor`],
    up: [`${composeBase} up --build`],
    down: [`${composeBase} down`],
    config: [`${composeBase} config`],
    ps: [`${composeBase} ps`],
    logs: [`${composeBase} logs -f --tail=120 ${diagnosticServices}`],
    dev: [`${composeBase} up -d --build --wait --wait-timeout ${waitTimeoutSeconds}`],
    recreate: [`${composeBase} up -d --build --force-recreate --wait --wait-timeout ${waitTimeoutSeconds}`],
  };

  const commands = commandsByAction[action];

  if (!commands) {
    console.error(`Unknown action: ${action}`);
    console.error('Usage: node scripts/dev-docker.mjs [dev|recreate|build|up|down|config|ps|logs]');
    process.exit(1);
  }

  try {
    if (action === 'dev' || action === 'up') {
      const proxyAlreadyRunning = await isComposeServiceRunning('proxy', mergedEnv);
      if (!proxyAlreadyRunning) {
        await ensurePortAvailable(proxyPort);
      }
    }

    for (const command of commands) {
      await run(command, mergedEnv);
    }
  } catch (error) {
    if (action === 'dev' || action === 'up') {
      await printFailureDiagnostics(mergedEnv);
    }

    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
