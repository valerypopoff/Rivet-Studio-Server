import { expect, test, type Page } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import {
  apiJson,
  createWorkflowProject,
  deleteWorkflowProject,
  type WorkflowProjectItem,
} from './helpers/workflowLibraryObserve';

type LoadedHostedProject = {
  contents: string;
  datasetsContents: string | null;
  revisionId: string | null;
};

async function publishWorkflowProject(page: Page, relativePath: string, endpointName: string): Promise<void> {
  await apiJson<{ project: WorkflowProjectItem }>(page, '/api/workflows/projects/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      relativePath,
      settings: { endpointName },
    }),
  });
}

async function loadHostedProject(page: Page, projectPath: string): Promise<LoadedHostedProject> {
  return apiJson<LoadedHostedProject>(page, '/api/projects/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: projectPath }),
  });
}

async function saveHostedProject(page: Page, projectPath: string, contents: string, datasetsContents: string | null): Promise<void> {
  await apiJson(page, '/api/projects/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: projectPath,
      contents,
      datasetsContents,
    }),
  });
}

test.describe('Workflow project version chooser', () => {
  test('unpublished_changes uses one chooser component for download and duplicate', async ({ page }) => {
    test.slow();

    const unique = `codex-version-modal-${Date.now()}`;
    const endpointName = `codex-version-modal-${Date.now()}`;
    let project: WorkflowProjectItem | null = null;

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    try {
      project = await createWorkflowProject(page, '', unique);
      await publishWorkflowProject(page, project.relativePath, endpointName);

      const loaded = await loadHostedProject(page, project.absolutePath);
      await saveHostedProject(page, project.absolutePath, `${loaded.contents}\n`, loaded.datasetsContents);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);

      const projectRow = page.locator('.project-row', { hasText: unique });
      const chooserModal = page.getByTestId('workflow-project-download-modal');

      await projectRow.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Download' }).click();
      await expect(chooserModal).toHaveCount(1);
      await expect(chooserModal).toBeVisible();
      await expect(chooserModal.locator('.project-settings-modal-title')).toHaveText('Download');
      await expect(page.getByRole('button', { name: 'Download "Published"' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Download "Unpublished changes"' })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(chooserModal).toHaveCount(0);

      await projectRow.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Duplicate' }).click();
      await expect(chooserModal).toHaveCount(1);
      await expect(chooserModal).toBeVisible();
      await expect(chooserModal.locator('.project-settings-modal-title')).toHaveText('Duplicate');
      await expect(page.getByRole('button', { name: 'Duplicate "Published"' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Duplicate "Unpublished changes"' })).toBeVisible();
    } finally {
      if (project) {
        await deleteWorkflowProject(page, project.relativePath).catch(() => {});
      }
    }
  });
});
