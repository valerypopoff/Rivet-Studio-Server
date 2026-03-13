import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

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
