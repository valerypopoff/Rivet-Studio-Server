import path from 'node:path';
import { loadDevEnv } from './lib/dev-env.mjs';
import {
  assertValidPort,
  ensurePortAvailable,
  isComposeServiceRunning,
  printFailureDiagnostics,
  run,
} from './lib/docker-launcher.mjs';
import {
  assertNoRetiredEnv,
  enableManagedWorkflowProfileIfNeeded,
} from './lib/docker-launcher-env.mjs';
import { prepareRivetDockerContext } from './lib/rivet-source-context.mjs';

const rootDir = process.cwd();
let composeBase = 'docker compose -f ops/compose/docker-compose.managed-services.yml -f ops/compose/docker-compose.yml';
const diagnosticServices = 'api web executor proxy';
let envFileLabel = '.env';

async function main() {
  const action = process.argv[2] == null ? 'prod' : process.argv[2];
  const { mergedEnv, envPath, hasEnvFile } = loadDevEnv(rootDir);

  envFileLabel = path.basename(envPath);
  if (hasEnvFile) {
    const relativeEnvPath = path.relative(rootDir, envPath) || envFileLabel;
    composeBase = `docker compose --env-file "${relativeEnvPath}" -f ops/compose/docker-compose.managed-services.yml -f ops/compose/docker-compose.yml`;
  }

  const buildHeavyActions = new Set(['build', 'up', 'prod', 'recreate', 'auto']);
  if (buildHeavyActions.has(action) && !Object.prototype.hasOwnProperty.call(mergedEnv, 'COMPOSE_PARALLEL_LIMIT')) {
    mergedEnv.COMPOSE_PARALLEL_LIMIT = '1';
  }

  assertNoRetiredEnv(mergedEnv, { launcherName: 'prod-docker', envFileLabel });
  enableManagedWorkflowProfileIfNeeded(mergedEnv);

  if (buildHeavyActions.has(action)) {
    prepareRivetDockerContext(rootDir, mergedEnv);
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
    'prod-prebuilt': [
      `${composeBase} pull web api executor`,
      `${composeBase} up -d --wait --wait-timeout ${waitTimeoutSeconds}`,
    ],
    'recreate-prebuilt': [
      `${composeBase} pull web api executor`,
      `${composeBase} up -d --force-recreate --wait --wait-timeout ${waitTimeoutSeconds}`,
    ],
  };

  // --- Auto mode: try prebuilt images first, fall back to local build ---
  if (action === 'auto') {
    const proxyAlreadyRunning = await isComposeServiceRunning('proxy', {
      composeBase,
      cwd: rootDir,
      env: mergedEnv,
    });
    if (!proxyAlreadyRunning) {
      await ensurePortAvailable(proxyPort, {
        envFileLabel,
        label: 'prod-docker',
      });
    }

    console.log('[prod] Pulling prebuilt images…');
    const pullExitCode = await run(
      `${composeBase} pull web api executor`,
      mergedEnv,
      { allowFailure: true, cwd: rootDir },
    );

    try {
      if (pullExitCode === 0) {
        console.log('[prod] Starting services from prebuilt images…');
        await run(
          `${composeBase} up -d --wait --wait-timeout ${waitTimeoutSeconds}`,
          mergedEnv,
          { cwd: rootDir },
        );
      } else {
        console.log('');
        console.log('[prod] Could not pull prebuilt images — building locally instead.');
        console.log('[prod] Local builds require at least 3 GB of free RAM.');
        console.log('[prod] Tip: push images to a container registry, then use "npm run prod:prebuilt".');
        console.log('');
        await run(
          `${composeBase} up -d --build --wait --wait-timeout ${waitTimeoutSeconds}`,
          mergedEnv,
          { cwd: rootDir },
        );
      }
    } catch (error) {
      await printFailureDiagnostics({
        composeBase,
        cwd: rootDir,
        diagnosticServices,
        env: mergedEnv,
        label: 'prod-docker',
      });
      throw error;
    }

    return;
  }

  const commands = commandsByAction[action];

  if (!commands) {
    console.error(`Unknown action: ${action}`);
    console.error('Usage: node scripts/prod-docker.mjs [auto|prod|recreate|build|up|down|config|ps|logs|prod-prebuilt|recreate-prebuilt]');
    process.exit(1);
  }

  try {
    if (action === 'prod' || action === 'up' || action === 'prod-prebuilt' || action === 'recreate-prebuilt') {
      const proxyAlreadyRunning = await isComposeServiceRunning('proxy', {
        composeBase,
        cwd: rootDir,
        env: mergedEnv,
      });
      if (!proxyAlreadyRunning) {
        await ensurePortAvailable(proxyPort, {
          envFileLabel,
          label: 'prod-docker',
        });
      }
    }

    for (const command of commands) {
      await run(command, mergedEnv, { cwd: rootDir });
    }
  } catch (error) {
    if (action === 'prod' || action === 'up' || action === 'prod-prebuilt' || action === 'recreate-prebuilt') {
      await printFailureDiagnostics({
        composeBase,
        cwd: rootDir,
        diagnosticServices,
        env: mergedEnv,
        label: 'prod-docker',
      });
    }

    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
