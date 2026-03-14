import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { loadDevEnv } from './lib/dev-env.mjs';

const rootDir = process.cwd();
let composeBase = 'docker compose -f ops/docker-compose.yml';
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
  console.error('[prod-docker] Docker compose reported a failure. Collecting container status and recent logs...');
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

function ensurePortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        reject(new Error(`[prod-docker] Host port ${port} is already in use. Set RIVET_PORT in ${envFileLabel} to a free port, or stop the process currently listening on ${port}.`));
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
  const action = process.argv[2] == null ? 'prod' : process.argv[2];
  const { mergedEnv, envPath, hasEnvFile } = loadDevEnv(rootDir);

  envFileLabel = path.basename(envPath);
  if (hasEnvFile) {
    const relativeEnvPath = path.relative(rootDir, envPath) || envFileLabel;
    composeBase = `docker compose --env-file "${relativeEnvPath}" -f ops/docker-compose.yml`;
  }

  if (!Object.prototype.hasOwnProperty.call(mergedEnv, 'COMPOSE_PARALLEL_LIMIT')) {
    mergedEnv.COMPOSE_PARALLEL_LIMIT = '1';
  }

  const waitTimeoutSeconds = parseInt(mergedEnv.RIVET_DOCKER_WAIT_TIMEOUT ?? '900', 10);
  const proxyPort = assertValidPort(mergedEnv.RIVET_PORT, 8080);
  const commandsByAction = {
    build: [`${composeBase} build web api executor`],
    up: [`${composeBase} up -d --build`],
    down: [`${composeBase} down`],
    config: [`${composeBase} config`],
    ps: [`${composeBase} ps`],
    logs: [`${composeBase} logs -f --tail=120 ${diagnosticServices}`],
    prod: [`${composeBase} up -d --build --wait --wait-timeout ${waitTimeoutSeconds}`],
    recreate: [`${composeBase} up -d --build --force-recreate --wait --wait-timeout ${waitTimeoutSeconds}`],
  };

  const commands = commandsByAction[action];

  if (!commands) {
    console.error(`Unknown action: ${action}`);
    console.error('Usage: node scripts/prod-docker.mjs [prod|recreate|build|up|down|config|ps|logs]');
    process.exit(1);
  }

  try {
    if (action === 'prod' || action === 'up') {
      const proxyAlreadyRunning = await isComposeServiceRunning('proxy', mergedEnv);
      if (!proxyAlreadyRunning) {
        await ensurePortAvailable(proxyPort);
      }
    }

    for (const command of commands) {
      await run(command, mergedEnv);
    }
  } catch (error) {
    if (action === 'prod' || action === 'up') {
      await printFailureDiagnostics(mergedEnv);
    }

    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
