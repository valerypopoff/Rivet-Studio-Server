import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function createWorkflowTestRoots(prefix: string): Promise<{
  tempRoot: string;
  workflowsRoot: string;
  appDataRoot: string;
  runtimeLibrariesRoot: string;
}> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workflowsRoot = path.join(tempRoot, 'workflows');
  const appDataRoot = path.join(tempRoot, 'app-data');
  const runtimeLibrariesRoot = path.join(tempRoot, 'runtime-libraries');

  await resetWorkflowTestRoots({ workflowsRoot, appDataRoot, runtimeLibrariesRoot });

  return {
    tempRoot,
    workflowsRoot,
    appDataRoot,
    runtimeLibrariesRoot,
  };
}

export async function resetWorkflowTestRoots(roots: {
  workflowsRoot: string;
  appDataRoot: string;
  runtimeLibrariesRoot?: string;
}) {
  const directories = [
    roots.workflowsRoot,
    roots.appDataRoot,
    ...(roots.runtimeLibrariesRoot ? [roots.runtimeLibrariesRoot] : []),
  ];

  for (const dirPath of directories) {
    await fs.rm(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.mkdir(dirPath, { recursive: true });
  }
}
