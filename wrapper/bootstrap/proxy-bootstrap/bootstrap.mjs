import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { shouldBootstrapManagedRuntimeLibrariesInCurrentProcess } from './config.mjs';
import {
  disposeManagedRuntimeLibrariesSync,
  setupManagedRuntimeLibrariesSync,
} from './runtime-libraries-sync.mjs';

const proxyEnvKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

if (proxyEnvKeys.some((key) => Boolean(process.env[key]?.trim()))) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

const shouldBootstrapManagedRuntimeLibraries = shouldBootstrapManagedRuntimeLibrariesInCurrentProcess();

if (shouldBootstrapManagedRuntimeLibraries) {
  setupManagedRuntimeLibrariesSync().catch((error) => {
    console.error('[runtime-libraries] Failed to initialize managed runtime-library sync:', error);
  });
}

let runtimeLibrariesSyncDisposed = false;

async function disposeRuntimeLibrariesSyncSafely() {
  if (!shouldBootstrapManagedRuntimeLibraries || runtimeLibrariesSyncDisposed) {
    return;
  }

  runtimeLibrariesSyncDisposed = true;
  try {
    await disposeManagedRuntimeLibrariesSync();
  } catch (error) {
    console.error('[runtime-libraries] Failed to dispose managed runtime-library sync:', error);
  }
}

process.once('SIGINT', () => {
  void disposeRuntimeLibrariesSyncSafely();
});

process.once('SIGTERM', () => {
  void disposeRuntimeLibrariesSyncSafely();
});
