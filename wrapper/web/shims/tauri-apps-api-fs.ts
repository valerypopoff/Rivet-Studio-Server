// Shim for @tauri-apps/api/fs
// All operations route through /api/native/* endpoints

import { RIVET_API_BASE_URL } from '../../shared/hosted-env';

const API = RIVET_API_BASE_URL;

export enum BaseDirectory {
  Audio = 1,
  Cache,
  Config,
  Data,
  LocalData,
  Desktop,
  Document,
  Download,
  Executable,
  Font,
  Home,
  Picture,
  Public,
  Runtime,
  Template,
  Video,
  Resource,
  App,
  Log,
  Temp,
  AppConfig,
  AppData,
  AppLocalData,
  AppCache,
  AppLog,
}

export interface FsOptions {
  dir?: BaseDirectory;
  recursive?: boolean;
}

export interface FileEntry {
  path: string;
  name?: string;
  children?: FileEntry[];
}

function baseDirName(dir?: BaseDirectory): string | undefined {
  if (dir === undefined) return undefined;
  const map: Record<number, string> = {
    [BaseDirectory.App]: 'app',
    [BaseDirectory.AppCache]: 'appCache',
    [BaseDirectory.AppConfig]: 'appConfig',
    [BaseDirectory.AppData]: 'appData',
    [BaseDirectory.AppLocalData]: 'appLocalData',
    [BaseDirectory.AppLog]: 'appLog',
    [BaseDirectory.Audio]: 'audio',
    [BaseDirectory.Cache]: 'cache',
    [BaseDirectory.Config]: 'config',
    [BaseDirectory.Data]: 'data',
    [BaseDirectory.Desktop]: 'desktop',
    [BaseDirectory.Document]: 'document',
    [BaseDirectory.Download]: 'download',
    [BaseDirectory.Executable]: 'executable',
    [BaseDirectory.Font]: 'font',
    [BaseDirectory.Home]: 'home',
    [BaseDirectory.LocalData]: 'localData',
    [BaseDirectory.Log]: 'log',
    [BaseDirectory.Picture]: 'picture',
    [BaseDirectory.Public]: 'public',
    [BaseDirectory.Resource]: 'resource',
    [BaseDirectory.Runtime]: 'runtime',
    [BaseDirectory.Temp]: 'temp',
    [BaseDirectory.Template]: 'template',
    [BaseDirectory.Video]: 'video',
  };
  return map[dir];
}

export async function readDir(
  path: string,
  options?: FsOptions,
): Promise<FileEntry[]> {
  const resp = await fetch(`${API}/native/readdir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      baseDir: baseDirName(options?.dir),
      options: { recursive: options?.recursive ?? false },
    }),
  });
  if (!resp.ok) throw new Error(`readDir failed: ${resp.statusText}`);
  return resp.json();
}

export async function readTextFile(
  path: string,
  options?: FsOptions,
): Promise<string> {
  const resp = await fetch(`${API}/native/read-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, baseDir: baseDirName(options?.dir) }),
  });
  if (!resp.ok) throw new Error(`readTextFile failed: ${resp.statusText}`);
  const data = await resp.json();
  return data.contents;
}

export async function readBinaryFile(
  path: string,
  options?: FsOptions,
): Promise<Uint8Array> {
  const resp = await fetch(`${API}/native/read-binary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, baseDir: baseDirName(options?.dir) }),
  });
  if (!resp.ok) throw new Error(`readBinaryFile failed: ${resp.statusText}`);
  const data = await resp.json();
  const binary = atob(data.contents);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function writeFile(
  path: string | { path: string; contents: string },
  contents?: string | Uint8Array,
  options?: FsOptions,
): Promise<void> {
  let filePath: string;
  let fileContents: string;
  let baseDir: string | undefined;

  if (typeof path === 'object') {
    filePath = path.path;
    fileContents = path.contents;
    baseDir = baseDirName(options?.dir);
  } else {
    filePath = path;
    fileContents = contents as string;
    baseDir = baseDirName(options?.dir);
  }

  const resp = await fetch(`${API}/native/write-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, contents: fileContents, baseDir }),
  });
  if (!resp.ok) throw new Error(`writeFile failed: ${resp.statusText}`);
}

export async function writeBinaryFile(
  path: string | { path: string; contents: Uint8Array },
  contents?: Uint8Array,
  options?: FsOptions,
): Promise<void> {
  let filePath: string;
  let fileContents: Uint8Array;
  let baseDir: string | undefined;

  if (typeof path === 'object') {
    filePath = path.path;
    fileContents = path.contents;
    baseDir = baseDirName(options?.dir);
  } else {
    filePath = path;
    fileContents = contents as Uint8Array;
    baseDir = baseDirName(options?.dir);
  }

  // Convert Uint8Array to base64
  let binary = '';
  for (let i = 0; i < fileContents.length; i++) {
    binary += String.fromCharCode(fileContents[i]!);
  }
  const b64 = btoa(binary);

  const resp = await fetch(`${API}/native/write-binary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, contents: b64, baseDir }),
  });
  if (!resp.ok) throw new Error(`writeBinaryFile failed: ${resp.statusText}`);
}

export async function writeTextFile(
  path: string | { path: string; contents: string },
  contents?: string,
  options?: FsOptions,
): Promise<void> {
  return writeFile(path, contents, options);
}

export async function exists(
  path: string,
  options?: FsOptions,
): Promise<boolean> {
  const resp = await fetch(`${API}/native/exists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, baseDir: baseDirName(options?.dir) }),
  });
  if (!resp.ok) throw new Error(`exists failed: ${resp.statusText}`);
  const data = await resp.json();
  return data.exists;
}

export async function createDir(
  path: string,
  options?: FsOptions,
): Promise<void> {
  const resp = await fetch(`${API}/native/mkdir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, recursive: options?.recursive ?? false }),
  });
  if (!resp.ok) throw new Error(`createDir failed: ${resp.statusText}`);
}

export async function removeDir(
  path: string,
  options?: FsOptions,
): Promise<void> {
  const resp = await fetch(`${API}/native/remove-dir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, recursive: options?.recursive ?? false }),
  });
  if (!resp.ok) throw new Error(`removeDir failed: ${resp.statusText}`);
}

export async function removeFile(
  path: string,
  options?: FsOptions,
): Promise<void> {
  const resp = await fetch(`${API}/native/remove-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, baseDir: baseDirName(options?.dir) }),
  });
  if (!resp.ok) throw new Error(`removeFile failed: ${resp.statusText}`);
}

export async function renameFile(
  oldPath: string,
  newPath: string,
  options?: FsOptions,
): Promise<void> {
  // No-op for now
  console.warn('renameFile not implemented in hosted shim');
}

export async function copyFile(
  source: string,
  destination: string,
  options?: FsOptions,
): Promise<void> {
  // No-op for now
  console.warn('copyFile not implemented in hosted shim');
}
