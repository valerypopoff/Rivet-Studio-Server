import path from 'node:path';

import './loadRootEnv.js';
import { badRequest } from './utils/httpError.js';

const repoRoot = path.resolve(process.cwd(), '..', '..');

const WORKSPACE_ROOT = process.env.RIVET_WORKSPACE_ROOT ?? repoRoot;
const APP_DATA_ROOT = process.env.RIVET_APP_DATA_ROOT ?? path.join(repoRoot, '.data', 'rivet-app');
const WORKFLOWS_ROOT = process.env.RIVET_WORKFLOWS_ROOT ?? path.join(repoRoot, 'workflows');

const ALLOWED_ROOTS = [
  path.resolve(WORKSPACE_ROOT),
  path.resolve(APP_DATA_ROOT),
  path.resolve(WORKFLOWS_ROOT),
  ...(process.env.RIVET_EXTRA_ROOTS?.split(',').map((r) => path.resolve(r.trim())) ?? []),
];

const ENV_ALLOWLIST = new Set([
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'OPENAI_ENDPOINT',
  ...(process.env.RIVET_ENV_ALLOWLIST?.split(',').map((v) => v.trim()) ?? []),
]);

const SHELL_ALLOWLIST = new Set([
  'git',
  'pnpm',
  ...(process.env.RIVET_SHELL_ALLOWLIST?.split(',').map((v) => v.trim()) ?? []),
]);

const COMMAND_TIMEOUT_MS = parseInt(process.env.RIVET_COMMAND_TIMEOUT ?? '30000', 10);
const MAX_OUTPUT_BYTES = parseInt(process.env.RIVET_MAX_OUTPUT ?? String(10 * 1024 * 1024), 10);

export function validatePath(inputPath: string): string {
  const resolved = path.resolve(inputPath);

  const cmp = process.platform === 'win32'
    ? (a: string, b: string) => a.toLowerCase().startsWith(b.toLowerCase())
    : (a: string, b: string) => a.startsWith(b);

  const isAllowed = ALLOWED_ROOTS.some((root) => cmp(resolved, root + path.sep) || resolved.length === root.length && cmp(resolved, root));

  if (!isAllowed) {
    throw badRequest(`Path not allowed: ${inputPath} (resolved: ${resolved})`);
  }

  return resolved;
}

export function isEnvAllowed(name: string): boolean {
  return ENV_ALLOWLIST.has(name);
}

export function isShellAllowed(program: string): boolean {
  const base = path.basename(program);
  return SHELL_ALLOWLIST.has(base);
}

export function getWorkspaceRoot(): string {
  return path.resolve(WORKSPACE_ROOT);
}

export function getAppDataRoot(): string {
  return path.resolve(APP_DATA_ROOT);
}

export function getWorkflowsRoot(): string {
  return path.resolve(WORKFLOWS_ROOT);
}

export function getCommandTimeout(): number {
  return COMMAND_TIMEOUT_MS;
}

export function getMaxOutputBytes(): number {
  return MAX_OUTPUT_BYTES;
}
