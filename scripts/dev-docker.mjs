import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { parseEnvFile } from './lib/env.mjs';

const rootDir = process.cwd();
const envPath = path.join(rootDir, '.env.dev');
const composeBase = 'docker compose -f ops/docker-compose.dev.yml';
const diagnosticServices = 'api web executor proxy';

function run(command, env, options = {}) {
  const allowFailure = options.allowFailure === true;

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: rootDir,
      env,
      shell: true,
      stdio: 'inherit',
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

function ensurePortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        reject(new Error(`[dev-docker] Host port ${port} is already in use. Set RIVET_PORT in .env.dev to a free port, or stop the process currently listening on ${port}.`));
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

async function main() {
  const action = process.argv[2] == null ? 'dev' : process.argv[2];
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

  if (Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_RUNTIME_LIBS_HOST_PATH')) {
    mergedEnv.RIVET_RUNTIME_LIBS_HOST_PATH = path.resolve(rootDir, fileEnv.RIVET_RUNTIME_LIBS_HOST_PATH);
  }

  if (!Object.prototype.hasOwnProperty.call(mergedEnv, 'COMPOSE_PARALLEL_LIMIT')) {
    mergedEnv.COMPOSE_PARALLEL_LIMIT = '1';
  }

  const waitTimeoutSeconds = parseInt(mergedEnv.RIVET_DOCKER_WAIT_TIMEOUT ?? '900', 10);
  const proxyPort = assertValidPort(mergedEnv.RIVET_PORT, 8080);

  const commandsByAction = {
    build: [`${composeBase} build api executor`],
    up: [`${composeBase} up --build`],
    down: [`${composeBase} down`],
    config: [`${composeBase} config`],
    ps: [`${composeBase} ps`],
    logs: [`${composeBase} logs -f --tail=120 ${diagnosticServices}`],
    dev: [`${composeBase} up --build -d --wait --wait-timeout ${waitTimeoutSeconds}`],
  };

  const commands = commandsByAction[action];

  if (!commands) {
    console.error(`Unknown action: ${action}`);
    console.error('Usage: node scripts/dev-docker.mjs [dev|build|up|down|config|ps|logs]');
    process.exit(1);
  }

  try {
    if (action === 'dev' || action === 'up') {
      await ensurePortAvailable(proxyPort);
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
