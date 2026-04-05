import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import {
  createWorkflowFolder,
  createWorkflowProject,
  deleteWorkflowFolder,
  deleteWorkflowProject,
  ensureFolderExpanded,
} from './helpers/workflowLibraryObserve';

test.describe('Hosted open-project cache after rename', () => {
  test('switching back to a renamed inactive open project does not reload it', async ({ page }) => {
    test.slow();

    const unique = `codex-open-cache-${Date.now()}`;
    const initialFolderName = `${unique}-folder`;
    const renamedFolderName = `${unique}-folder-renamed`;
    const nestedProjectName = `${unique}-nested`;
    const rootProjectName = `${unique}-root`;

    let folderRelativePath = '';
    let nestedProjectRelativePath = '';
    let rootProjectRelativePath = '';

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    try {
      const folder = await createWorkflowFolder(page, initialFolderName);
      const nestedProject = await createWorkflowProject(page, folder.relativePath, nestedProjectName);
      const rootProject = await createWorkflowProject(page, '', rootProjectName);

      folderRelativePath = folder.relativePath;
      nestedProjectRelativePath = nestedProject.relativePath;
      rootProjectRelativePath = rootProject.relativePath;

      await page.reload({ waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);

      await ensureFolderExpanded(page, initialFolderName, nestedProjectName);
      await page.locator('.project-row', { hasText: nestedProjectName }).dblclick();
      await expect(page.locator('.active-project-name')).toHaveText(nestedProjectName, { timeout: 120_000 });
      await expect(page.locator('.active-project-save-button')).toHaveText('Save', { timeout: 120_000 });

      await page.locator('.project-row', { hasText: rootProjectName }).dblclick();
      await expect(page.locator('.active-project-name')).toHaveText(rootProjectName, { timeout: 120_000 });
      await expect(page.locator('.active-project-save-button')).toHaveText('Save', { timeout: 120_000 });

      page.once('dialog', (dialog) => dialog.accept(renamedFolderName));
      await page.locator('.folder-row', { hasText: initialFolderName }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Rename folder' }).click();
      await expect(page.locator('.folder-row', { hasText: renamedFolderName })).toBeVisible({ timeout: 30_000 });

      folderRelativePath = renamedFolderName;
      nestedProjectRelativePath = `${renamedFolderName}/${nestedProjectName}.rivet-project`;

      await ensureFolderExpanded(page, renamedFolderName, nestedProjectName);

      let loadRequestCount = 0;
      const handleRequest = (request: { method: () => string; url: () => string }) => {
        if (request.method() !== 'POST') {
          return;
        }

        const url = new URL(request.url());
        if (url.pathname === '/api/projects/load') {
          loadRequestCount += 1;
        }
      };

      page.on('request', handleRequest);
      try {
        await page.locator('.project-row', { hasText: nestedProjectName }).dblclick();
        await expect(page.locator('.active-project-name')).toHaveText(nestedProjectName, { timeout: 30_000 });
        await expect(page.locator('.active-project-save-button')).toHaveText('Save', { timeout: 30_000 });
        await page.waitForTimeout(750);
      } finally {
        page.off('request', handleRequest);
      }

      expect(loadRequestCount).toBe(0);
    } finally {
      if (rootProjectRelativePath) {
        await deleteWorkflowProject(page, rootProjectRelativePath).catch(() => {});
      }
      if (nestedProjectRelativePath) {
        await deleteWorkflowProject(page, nestedProjectRelativePath).catch(() => {});
      }
      if (folderRelativePath) {
        await deleteWorkflowFolder(page, folderRelativePath).catch(() => {});
      }
    }
  });
});
