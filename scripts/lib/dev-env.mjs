import path from 'node:path';
import { parseEnvFile } from './env.mjs';

export function loadDevEnv(rootDir) {
  const envPath = path.join(rootDir, '.env.dev');
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

  if (!Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_RUNTIME_LIBRARIES_ROOT')) {
    mergedEnv.RIVET_RUNTIME_LIBRARIES_ROOT = path.join(rootDir, '.data', 'runtime-libraries');
  }

  if (Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_WORKFLOWS_HOST_PATH')) {
    mergedEnv.RIVET_WORKFLOWS_HOST_PATH = path.resolve(rootDir, fileEnv.RIVET_WORKFLOWS_HOST_PATH);
  }

  if (Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_RUNTIME_LIBS_HOST_PATH')) {
    mergedEnv.RIVET_RUNTIME_LIBS_HOST_PATH = path.resolve(rootDir, fileEnv.RIVET_RUNTIME_LIBS_HOST_PATH);
  }

  return { envPath, fileEnv, mergedEnv };
}
