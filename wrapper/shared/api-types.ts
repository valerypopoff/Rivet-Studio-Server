// Typed contracts between frontend shims and API backend

export const API_BASE = '/api';

export interface InvokeRequest {
  command: string;
  args: Record<string, unknown>;
}

export interface InvokeResponse {
  result: unknown;
}

export interface ShellExecRequest {
  program: string;
  args: string[];
  options?: { cwd?: string; encoding?: string };
}

export interface ShellExecResponse {
  code: number;
  stdout: string;
  stderr: string;
}

export interface NativeReadDirRequest {
  path: string;
  baseDir?: string;
  options?: {
    recursive?: boolean;
    includeDirectories?: boolean;
    filterGlobs?: string[];
    relative?: boolean;
    ignores?: string[];
  };
}

export interface NativeReadTextRequest {
  path: string;
  baseDir?: string;
}

export interface NativeReadBinaryRequest {
  path: string;
  baseDir?: string;
}

export interface NativeWriteTextRequest {
  path: string;
  contents: string;
  baseDir?: string;
}

export interface NativeWriteBinaryRequest {
  path: string;
  contents: string; // base64
  baseDir?: string;
}

export interface NativeExistsRequest {
  path: string;
  baseDir?: string;
}

export interface NativeMkdirRequest {
  path: string;
  recursive?: boolean;
}

export interface NativeRemoveDirRequest {
  path: string;
  recursive?: boolean;
}

export interface PluginInstallRequest {
  package: string;
  tag: string;
}

export interface PluginInstallResponse {
  success: boolean;
  log: string;
}

export interface PluginLoadMainRequest {
  package: string;
  tag: string;
}

export interface PluginLoadMainResponse {
  contents: string;
}

export interface ProjectListResponse {
  files: string[];
}

export interface RuntimeConfig {
  hostedMode: boolean;
  executorWsUrl: string;
  remoteDebuggerDefaultWs: string;
  apiBaseUrl: string;
}
