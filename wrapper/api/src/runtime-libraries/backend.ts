import type { Request, Response } from 'express';

import type {
  RuntimeLibrariesState,
  RuntimeLibraryJobState,
  RuntimeLibraryPackageSpec,
} from '../../../shared/runtime-library-types.js';
import { createFilesystemRuntimeLibrariesBackend } from './filesystem-backend.js';
import { getRuntimeLibrariesBackendMode } from './config.js';
import { ManagedRuntimeLibrariesBackend } from './managed/backend.js';

export interface RuntimeLibrariesBackend {
  initialize(): Promise<void>;
  prepareForExecution(): Promise<void>;
  getState(): Promise<RuntimeLibrariesState>;
  enqueueInstall(packages: RuntimeLibraryPackageSpec[]): Promise<RuntimeLibraryJobState>;
  enqueueRemove(packageNames: string[]): Promise<RuntimeLibraryJobState>;
  getJob(jobId: string): Promise<RuntimeLibraryJobState | null>;
  cancelJob(jobId: string): Promise<RuntimeLibraryJobState | null>;
  streamJob(req: Request, res: Response): Promise<void> | void;
  dispose?(): Promise<void>;
}

let runtimeLibrariesBackend: RuntimeLibrariesBackend | null = null;

export function getRuntimeLibrariesBackend(): RuntimeLibrariesBackend {
  if (runtimeLibrariesBackend) {
    return runtimeLibrariesBackend;
  }

  runtimeLibrariesBackend = getRuntimeLibrariesBackendMode() === 'managed'
    ? new ManagedRuntimeLibrariesBackend()
    : createFilesystemRuntimeLibrariesBackend();

  return runtimeLibrariesBackend;
}

export async function initializeRuntimeLibrariesBackend(): Promise<void> {
  await getRuntimeLibrariesBackend().initialize();
}

export async function prepareRuntimeLibrariesForExecution(): Promise<void> {
  await getRuntimeLibrariesBackend().prepareForExecution();
}

export async function disposeRuntimeLibrariesBackend(): Promise<void> {
  if (!runtimeLibrariesBackend) {
    return;
  }

  await runtimeLibrariesBackend.dispose?.();
  runtimeLibrariesBackend = null;
}
