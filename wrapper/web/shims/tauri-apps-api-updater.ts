// Shim for @tauri-apps/api/updater
// Disabled in hosted mode — no desktop updater

export interface UpdateManifest {
  version: string;
  date?: string;
  body?: string;
}

export interface UpdateResult {
  shouldUpdate: boolean;
  manifest?: UpdateManifest;
}

export type UpdateStatusResult = {
  error?: string;
  status: 'PENDING' | 'ERROR' | 'DONE' | 'UPTODATE';
};

export async function checkUpdate(): Promise<UpdateResult> {
  return { shouldUpdate: false };
}

export async function installUpdate(): Promise<void> {
  // no-op
}

export function onUpdaterEvent(
  _handler: (status: UpdateStatusResult) => void,
): Promise<() => void> {
  return Promise.resolve(() => {});
}
