// Runtime environment constants for hosted mode
// These use window.location so they work regardless of the deployment host/port

const wsProtocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsBase = typeof window !== 'undefined' ? `${wsProtocol}//${window.location.host}` : 'ws://localhost';
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export const RIVET_HOSTED_MODE = true;
export const RIVET_API_BASE_URL = '/api';
export const RIVET_EXECUTOR_WS_URL = `${wsBase}/ws/executor/internal`;
export const RIVET_REMOTE_DEBUGGER_DEFAULT_WS = `${wsBase}/ws/executor`;
export const RIVET_DEBUG_LOGS = viteEnv?.VITE_RIVET_DEBUG_LOGS === 'true';

export function logHostedDebug(
  method: 'log' | 'info' | 'warn' | 'error' | 'debug',
  ...args: unknown[]
) {
  if (!RIVET_DEBUG_LOGS) {
    return;
  }

  console[method](...args);
}
