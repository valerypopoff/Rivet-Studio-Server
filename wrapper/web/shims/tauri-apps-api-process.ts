// Shim for @tauri-apps/api/process
// relaunch() -> window.location.reload()

export async function relaunch(): Promise<void> {
  window.location.reload();
}

export async function exit(_code?: number): Promise<void> {
  // no-op in browser
  console.warn('exit() called in hosted mode, ignoring');
}
