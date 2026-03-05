// Shim for @tauri-apps/api/app

export async function getVersion(): Promise<string> {
  return 'hosted';
}

export async function getName(): Promise<string> {
  return 'Rivet (Hosted)';
}

export async function getTauriVersion(): Promise<string> {
  return '0.0.0';
}
