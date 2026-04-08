import { expect, test, type Page } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

type MockWorkflowProjectItem = {
  id: string;
  name: string;
  fileName: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
  settings: {
    status: 'unpublished' | 'published' | 'unpublished_changes';
    endpointName: string;
    lastPublishedAt: string | null;
  };
};

function createProjectSettingsFixture(name: string): MockWorkflowProjectItem {
  return {
    id: 'project-settings-fixture',
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${name}.rivet-project`,
    absolutePath: `/managed/workflows/${name}.rivet-project`,
    updatedAt: '2026-04-08T10:00:00.000Z',
    settings: {
      status: 'unpublished',
      endpointName: '',
      lastPublishedAt: null,
    },
  };
}

async function installProjectSettingsRoutes(page: Page, project: MockWorkflowProjectItem): Promise<void> {
  await page.route('**/api/workflows/tree', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        folders: [],
        projects: [project],
      }),
    });
  });

  await page.route('**/api/workflows/projects/publish', async (route) => {
    const requestBody = route.request().postDataJSON() as {
      settings?: { endpointName?: string };
    };
    project.settings = {
      status: 'published',
      endpointName: requestBody.settings?.endpointName ?? project.settings.endpointName,
      lastPublishedAt: '2026-04-08T10:30:00.000Z',
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ project }),
    });
  });

  await page.route('**/api/workflows/projects/unpublish', async (route) => {
    project.settings = {
      status: 'unpublished',
      endpointName: '',
      lastPublishedAt: null,
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ project }),
    });
  });
}

test.describe('Project settings modal', () => {
  test('rename validation, publish validation, unpublish flow, and delete availability stay intact', async ({ page }) => {
    test.slow();

    const unique = 'codex-project-settings-fixture';
    const endpointName = 'codex-project-settings-endpoint';
    const project = createProjectSettingsFixture(unique);
    await installProjectSettingsRoutes(page, project);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const projectRow = page.locator('.project-row', { hasText: unique });
    await expect(projectRow).toBeVisible({ timeout: 30_000 });
    await projectRow.click();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const modal = page.getByTestId('workflow-project-settings-modal');
    await expect(modal).toBeVisible();

    await expect(modal.locator('.project-settings-rename-button')).toBeVisible();
    await modal.locator('.project-settings-rename-button').click();
    const titleInput = modal.locator('.project-settings-title-input input');
    await titleInput.fill('');
    await titleInput.press('Enter');
    await expect(modal.locator('.project-settings-error')).toContainText('Project name is required.');

    await titleInput.fill(unique);
    await titleInput.press('Enter');
    await expect(titleInput).toHaveCount(0);

    const deleteButton = modal.getByRole('button', { name: 'Delete project' });
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toBeEnabled();

    await modal.getByRole('button', { name: 'Publish...' }).click();
    const endpointInput = modal.locator('#workflow-project-endpoint-name');
    await endpointInput.fill('bad endpoint');
    await expect(modal.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await expect(modal.locator('.project-settings-error')).toContainText(
      'Endpoint name must contain only letters, numbers, and hyphens.',
    );

    await endpointInput.fill(endpointName);
    await expect(modal.getByRole('button', { name: 'Publish' })).toBeEnabled();
    await modal.getByRole('button', { name: 'Publish' }).click();
    await expect(modal.locator('.project-status-badge.published')).toBeVisible({ timeout: 30_000 });
    await expect(modal.getByRole('button', { name: 'Delete project' })).toHaveCount(0);

    page.once('dialog', (dialog) => dialog.accept());
    await modal.getByRole('button', { name: 'Unpublish' }).click();
    await expect(modal.locator('.project-status-badge.unpublished')).toBeVisible({ timeout: 30_000 });
    await expect(modal.getByRole('button', { name: 'Delete project' })).toBeVisible();
  });
});
