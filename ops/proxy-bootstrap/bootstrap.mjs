import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { setupManagedRuntimeLibrariesSync } from './runtime-libraries-sync.mjs';

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

setupManagedRuntimeLibrariesSync().catch((error) => {
  console.error('[runtime-libraries] Failed to initialize managed runtime-library sync:', error);
});
