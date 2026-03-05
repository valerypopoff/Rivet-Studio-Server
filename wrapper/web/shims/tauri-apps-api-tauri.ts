// Shim for @tauri-apps/api/tauri
// invoke(cmd, args) -> POST /api/compat/invoke

import { RIVET_API_BASE_URL } from '../../shared/hosted-env';

const API = RIVET_API_BASE_URL;

export async function invoke<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${API}/compat/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: cmd, args: args ?? {} }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`invoke(${cmd}) failed: ${text}`);
  }

  const data = await resp.json();
  return data.result as T;
}

export function convertFileSrc(filePath: string, _protocol?: string): string {
  return filePath;
}

export function transformCallback(callback?: (response: any) => void, once?: boolean): number {
  // no-op
  return 0;
}
