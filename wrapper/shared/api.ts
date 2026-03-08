import { RIVET_API_BASE_URL } from './hosted-env';

const API = RIVET_API_BASE_URL;

export async function apiReadText(path: string): Promise<string> {
  const resp = await fetch(`${API}/native/read-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) throw new Error(`Failed to read file: ${resp.statusText}`);
  const data = await resp.json();
  return data.contents;
}

export async function apiWriteText(path: string, contents: string): Promise<void> {
  const resp = await fetch(`${API}/native/write-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, contents }),
  });
  if (!resp.ok) throw new Error(`Failed to write file: ${resp.statusText}`);
}

export async function apiReadBinary(path: string): Promise<Uint8Array> {
  const resp = await fetch(`${API}/native/read-binary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) throw new Error(`Failed to read binary file: ${resp.statusText}`);
  const data = await resp.json();
  const binary = atob(data.contents);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function apiExists(path: string): Promise<boolean> {
  const resp = await fetch(`${API}/native/exists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) return false;
  const data = await resp.json();
  return data.exists;
}
