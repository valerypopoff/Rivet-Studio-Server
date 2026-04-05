import { expect, test, type Page } from '@playwright/test';

export type WorkflowFolderItem = {
  relativePath: string;
  name: string;
};

export type WorkflowProjectItem = {
  relativePath: string;
  absolutePath: string;
  name: string;
};

function getStorageModeFromEnv(): 'filesystem' | 'managed' {
  const value = process.env.RIVET_STORAGE_MODE ?? 'filesystem';

  return value.trim().toLowerCase() === 'managed' ? 'managed' : 'filesystem';
}

export function requireManagedMutationOptIn(): void {
  test.skip(
    getStorageModeFromEnv() === 'managed' && process.env.PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS !== '1',
    'Mutating workflow Playwright specs are blocked against managed storage unless PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS=1 is set.',
  );
}

export async function apiJson<T>(page: Page, input: string, init?: RequestInit): Promise<T> {
  return page.evaluate(async ({ input, init }) => {
    const response = await fetch(input, init);
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const message = body && typeof body === 'object' && 'error' in body ? String(body.error) : response.statusText;
      throw new Error(`${response.status} ${message}`);
    }

    return body as T;
  }, { input, init });
}

export async function createWorkflowFolder(page: Page, name: string): Promise<WorkflowFolderItem> {
  const response = await apiJson<{ folder: WorkflowFolderItem }>(page, '/api/workflows/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  return response.folder;
}

export async function createWorkflowProject(
  page: Page,
  folderRelativePath: string,
  name: string,
): Promise<WorkflowProjectItem> {
  const response = await apiJson<{ project: WorkflowProjectItem }>(page, '/api/workflows/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderRelativePath, name }),
  });

  return response.project;
}

export async function deleteWorkflowProject(page: Page, relativePath: string): Promise<void> {
  await apiJson<{ deleted: true }>(page, '/api/workflows/projects', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath }),
  });
}

export async function deleteWorkflowFolder(page: Page, relativePath: string): Promise<void> {
  await apiJson<{ deleted: true }>(page, '/api/workflows/folders', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath }),
  });
}

export async function ensureFolderExpanded(page: Page, folderName: string, projectName?: string): Promise<void> {
  const folderRow = page.locator('.folder-row', { hasText: folderName });
  await expect(folderRow).toBeVisible({ timeout: 30_000 });

  if ((await folderRow.getAttribute('aria-expanded')) !== 'true') {
    await folderRow.click();
  }

  await expect(folderRow).toHaveAttribute('aria-expanded', 'true', { timeout: 30_000 });

  if (!projectName) {
    return;
  }

  await expect(page.locator('.project-row', { hasText: projectName })).toBeVisible({ timeout: 30_000 });
}
