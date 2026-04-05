import { isManagedRuntimeLibrariesEnabled } from './config.mjs';
import { createManagedRuntimeLibrariesSyncController } from './sync.mjs';

const RETRYABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

let setupPromise = null;
let pollerStarted = false;
let pollerHandle = null;
let controller = null;

async function setupManagedRuntimeLibrariesSync() {
  if (setupPromise) {
    return setupPromise;
  }

  if (!isManagedRuntimeLibrariesEnabled()) {
    globalThis.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = async () => {};
    return;
  }

  setupPromise = (async () => {
    controller = createManagedRuntimeLibrariesSyncController();
    await controller.initialize();

    globalThis.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = async () => {
      try {
        await controller.syncCurrentRelease(true);
      } catch (error) {
        const code = typeof error === 'object' && error != null && 'code' in error ? String(error.code ?? '') : '';
        if (RETRYABLE_CODES.has(code)) {
          await controller.syncCurrentRelease(true);
          return;
        }

        throw error;
      }
    };

    if (!pollerStarted) {
      pollerStarted = true;
      pollerHandle = setInterval(() => {
        void controller.syncCurrentRelease(false).catch((error) => {
          console.error('[runtime-libraries] managed sync poll failed:', error);
        });
      }, controller.config.syncPollIntervalMs);
      pollerHandle.unref?.();
    }
  })().catch((error) => {
    setupPromise = null;
    controller = null;
    throw error;
  });

  return setupPromise;
}

async function disposeManagedRuntimeLibrariesSync() {
  setupPromise = null;
  globalThis.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = async () => {};

  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
  pollerStarted = false;

  const currentController = controller;
  controller = null;
  if (currentController) {
    await currentController.dispose();
  }
}

export { setupManagedRuntimeLibrariesSync, disposeManagedRuntimeLibrariesSync };
