import net from 'node:net';
import { spawn } from 'node:child_process';

export function run(command, env, options = {}) {
  const allowFailure = options.allowFailure === true;
  const stdio = options.stdio ?? 'inherit';
  const cwd = options.cwd ?? process.cwd();

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
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

export function runCapture(command, env, options = {}) {
  const allowFailure = options.allowFailure === true;
  const cwd = options.cwd ?? process.cwd();

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
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

export function assertValidPort(value, fallback) {
  const parsed = parseInt(value == null ? '' : value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }

  return parsed;
}

export function ensurePortAvailable(port, options) {
  const { envFileLabel, label } = options;

  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        reject(new Error(`[${label}] Host port ${port} is already in use. Set RIVET_PORT in ${envFileLabel} to a free port, or stop the process currently listening on ${port}.`));
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

export async function isComposeServiceRunning(service, options) {
  const { composeBase, cwd, env } = options;
  const result = await runCapture(`${composeBase} ps --status running --services ${service}`, env, {
    allowFailure: true,
    cwd,
  });

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(service);
}

export async function printFailureDiagnostics(options) {
  const { composeBase, cwd, diagnosticServices, env, label } = options;
  console.error(`[${label}] Docker compose reported a failure. Collecting container status and recent logs...`);
  await run(`${composeBase} ps`, env, { allowFailure: true, cwd });
  await run(`${composeBase} logs --tail=120 ${diagnosticServices}`, env, { allowFailure: true, cwd });
}
