import { expect, test, type Page } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

type MockWorkflowProjectItem = {
  id: string;
  name: string;
  fileName: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
  stats?: {
    graphCount: number;
    totalNodeCount: number;
  };
  settings: {
    status: 'unpublished' | 'published' | 'unpublished_changes';
    endpointName: string;
    lastPublishedAt: string | null;
  };
};

type MockPublishedVersionSummary = {
  id: string;
  projectId: string;
  projectName: string;
  endpointName: string;
  publishedAt: string;
  isCurrent: boolean;
  isStarred: boolean;
};

function createProjectSettingsFixture(name: string): MockWorkflowProjectItem {
  return {
    id: 'project-settings-fixture',
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${name}.rivet-project`,
    absolutePath: `/managed/workflows/${name}.rivet-project`,
    updatedAt: '2026-04-08T10:00:00.000Z',
    stats: {
      graphCount: 2,
      totalNodeCount: 7,
    },
    settings: {
      status: 'unpublished',
      endpointName: '',
      lastPublishedAt: null,
    },
  };
}

function createPublishedVersionPreviewProject(project: MockWorkflowProjectItem, versionId: string): string {
  const graphId = `${versionId}-graph`;

  return [
    'version: 4',
    'data:',
    '  metadata:',
    `    id: ${JSON.stringify(project.id)}`,
    `    title: ${JSON.stringify(project.name)}`,
    '    description: ""',
    `    mainGraphId: ${JSON.stringify(graphId)}`,
    '  graphs:',
    `    ${JSON.stringify(graphId)}:`,
    '      metadata:',
    `        id: ${JSON.stringify(graphId)}`,
    '        name: "Main Graph"',
    '        description: ""',
    '      nodes: {}',
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}

async function installProjectSettingsRoutes(
  page: Page,
  project: MockWorkflowProjectItem,
  options: {
    projectLoadRequests: Array<{ path: string }>;
    publishedVersionPreviewRequests: Array<{ relativePath: string; versionId: string }>;
    publishedVersionStarRequests: Array<{ relativePath: string; versionId: string; isStarred: boolean }>;
    publishedVersionRestoreRequests: Array<{ relativePath: string; versionId: string }>;
  },
): Promise<void> {
  const publishedVersions: MockPublishedVersionSummary[] = Array.from({ length: 12 }, (_, index) => ({
    id: `published-version-${index + 1}`,
    projectId: project.id,
    projectName: project.name,
    endpointName: `codex-project-settings-endpoint-${index + 1}`,
    publishedAt: new Date(Date.UTC(2026, 3, 8, 10, 30 - index, 0)).toISOString(),
    isCurrent: false,
    isStarred: false,
  }));
  const getPublishedVersions = () => {
    const endpointName = project.settings.endpointName || 'codex-project-settings-endpoint';
    return publishedVersions.map((version, index) => ({
      ...version,
      endpointName: index === 0 ? endpointName : `${endpointName}-${index + 1}`,
      isCurrent: index === 0 && project.settings.status !== 'unpublished',
    }));
  };

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

  await page.route('**/api/projects/load', async (route) => {
    const requestBody = route.request().postDataJSON() as {
      path: string;
    };
    options.projectLoadRequests.push(requestBody);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents: createPublishedVersionPreviewProject(project, `live-${options.projectLoadRequests.length}`),
        datasetsContents: null,
        revisionId: `revision-${options.projectLoadRequests.length}`,
      }),
    });
  });

  await page.route('**/api/workflows/projects/published-versions?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        versions: getPublishedVersions(),
      }),
    });
  });

  await page.route('**/api/workflows/projects/published-versions/star', async (route) => {
    const requestBody = route.request().postDataJSON() as {
      relativePath: string;
      versionId: string;
      isStarred: boolean;
    };
    options.publishedVersionStarRequests.push(requestBody);
    const version = publishedVersions.find((candidate) => candidate.id === requestBody.versionId);
    if (!version) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Published version not found' }),
      });
      return;
    }

    version.isStarred = requestBody.isStarred;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: getPublishedVersions().find((candidate) => candidate.id === requestBody.versionId),
      }),
    });
  });

  await page.route('**/api/workflows/projects/published-versions/preview', async (route) => {
    const requestBody = route.request().postDataJSON() as {
      relativePath: string;
      versionId: string;
    };
    options.publishedVersionPreviewRequests.push(requestBody);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents: createPublishedVersionPreviewProject(project, requestBody.versionId),
        datasetsContents: null,
      }),
    });
  });

  await page.route('**/api/workflows/projects/published-versions/restore', async (route) => {
    const requestBody = route.request().postDataJSON() as {
      relativePath: string;
      versionId: string;
    };
    options.publishedVersionRestoreRequests.push(requestBody);
    const sourceVersion = publishedVersions.find((candidate) => candidate.id === requestBody.versionId);
    const sourceSummary = getPublishedVersions().find((candidate) => candidate.id === requestBody.versionId);
    if (!sourceVersion) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Published version not found' }),
      });
      return;
    }

    publishedVersions.forEach((version) => {
      version.isCurrent = false;
    });
    const restoredVersion: MockPublishedVersionSummary = {
      ...sourceVersion,
      id: `restored-${sourceVersion.id}`,
      endpointName: sourceSummary?.endpointName ?? sourceVersion.endpointName,
      publishedAt: new Date(Date.UTC(2026, 3, 8, 11, 0, 0)).toISOString(),
      isCurrent: true,
      isStarred: false,
    };
    publishedVersions.unshift(restoredVersion);
    project.settings = {
      status: 'published',
      endpointName: restoredVersion.endpointName,
      lastPublishedAt: restoredVersion.publishedAt,
    };

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project,
        version: getPublishedVersions().find((candidate) => candidate.id === restoredVersion.id),
      }),
    });
  });
}

test.describe('Project settings modal', () => {
  test('publish validation, unpublish flow, and delete availability stay intact without modal rename controls', async ({ page }) => {
    test.slow();

    const unique = 'codex-project-settings-fixture';
    const endpointName = 'codex-project-settings-endpoint';
    const project = createProjectSettingsFixture(unique);
    const projectLoadRequests: Array<{ path: string }> = [];
    const publishedVersionPreviewRequests: Array<{ relativePath: string; versionId: string }> = [];
    const publishedVersionStarRequests: Array<{ relativePath: string; versionId: string; isStarred: boolean }> = [];
    const publishedVersionRestoreRequests: Array<{ relativePath: string; versionId: string }> = [];
    await installProjectSettingsRoutes(page, project, {
      projectLoadRequests,
      publishedVersionPreviewRequests,
      publishedVersionStarRequests,
      publishedVersionRestoreRequests,
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const projectRow = page.locator('.project-row', { hasText: unique });
    await expect(projectRow).toBeVisible({ timeout: 30_000 });
    await projectRow.click();
    await expect(page.locator('.active-project-stats')).toHaveText('2 graphs, 7 nodes total');

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const modal = page.getByTestId('workflow-project-settings-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.project-settings-modal-title')).toHaveText(unique);
    await expect(modal.getByRole('button', { name: 'Rename project' })).toHaveCount(0);
    await expect(modal.locator('.project-settings-title-input input')).toHaveCount(0);

    const deleteButton = modal.getByRole('button', { name: 'Delete project' });
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toBeEnabled();

    await modal.getByRole('button', { name: 'Publish...' }).click();
    const endpointInput = modal.locator('#workflow-project-endpoint-name');
    await expect(modal.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Published version history' })).toHaveCount(0);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(endpointInput).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Published version history' })).toBeVisible();

    await modal.getByRole('button', { name: 'Publish...' }).click();
    await endpointInput.fill('bad endpoint');
    await expect(modal.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await expect(modal.locator('.project-settings-error')).toContainText(
      'Endpoint name must contain only letters, numbers, and hyphens.',
    );

    await endpointInput.fill(endpointName);
    await expect(modal.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
    await modal.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(modal.locator('.project-status-badge.published')).toBeVisible({ timeout: 30_000 });
    await expect(modal.getByRole('button', { name: 'Delete project' })).toHaveCount(0);

    await modal.getByRole('button', { name: 'Published version history' }).click();
    const historyModal = page.getByTestId('workflow-published-version-history-modal');
    await expect(historyModal).toBeVisible();
    await expect(historyModal).toContainText('Published version history');
    await expect(historyModal).toContainText(endpointName);
    await expect(historyModal).toContainText('Current');
    await expect(historyModal.getByRole('listitem')).toHaveCount(10);
    await expect(historyModal.getByRole('button', { name: 'Preview' })).toHaveCount(10);
    await expect(historyModal.getByRole('button', { name: 'Restore' })).toHaveCount(10);
    await expect(historyModal.getByRole('button', { name: 'Star published version' })).toHaveCount(10);
    await historyModal.getByRole('button', { name: 'Star published version' }).first().click();
    await expect(historyModal.getByRole('button', { name: 'Unstar published version' })).toHaveCount(1);
    expect(publishedVersionStarRequests).toEqual([{
      relativePath: project.relativePath,
      versionId: 'published-version-1',
      isStarred: true,
    }]);
    await historyModal.getByRole('button', { name: 'Close published version history' }).click();
    await expect(historyModal).toHaveCount(0);
    await modal.getByRole('button', { name: 'Published version history' }).click();
    await expect(historyModal.getByRole('button', { name: 'Unstar published version' })).toHaveCount(1);
    await expect(historyModal.getByText('Page 1 of 2')).toBeVisible();
    await expect(historyModal.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await historyModal.getByRole('button', { name: 'Next' }).click();
    await expect(historyModal.getByRole('listitem')).toHaveCount(2);
    await expect(historyModal.getByText('Page 2 of 2')).toBeVisible();
    await expect(historyModal).toContainText(`${endpointName}-11`);
    await expect(historyModal.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
    await historyModal.getByRole('button', { name: 'Previous' }).click();
    await historyModal.getByRole('button', { name: 'Preview' }).first().click();
    await expect(historyModal).toHaveCount(0);
    await expect.poll(() => publishedVersionPreviewRequests.length).toBe(1);
    expect(publishedVersionPreviewRequests[0]).toEqual({
      relativePath: project.relativePath,
      versionId: 'published-version-1',
    });
    await expect(page.locator('.dashboard-empty-state')).toBeHidden();
    await expect(page.locator('.Toastify__toast', { hasText: 'Failed to open project' })).toHaveCount(0);
    await expect(modal).toHaveCount(0);

    await projectRow.click();
    await projectRow.dblclick();
    await expect.poll(() => projectLoadRequests.length).toBe(1);
    expect(projectLoadRequests[0]).toEqual({
      path: project.absolutePath,
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('.project-status-badge.published')).toBeVisible({ timeout: 30_000 });

    await modal.getByRole('button', { name: 'Published version history' }).click();
    await expect(historyModal).toBeVisible();
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Restore this published version');
      await dialog.accept();
    });
    await historyModal.getByRole('button', { name: 'Restore' }).first().click();
    await expect.poll(() => publishedVersionRestoreRequests.length).toBe(1);
    expect(publishedVersionRestoreRequests[0]).toEqual({
      relativePath: project.relativePath,
      versionId: 'published-version-1',
    });
    await expect(historyModal.getByRole('listitem').first()).toContainText(endpointName);
    await expect(historyModal.getByRole('listitem').first()).toContainText('Current');
    await expect(historyModal.getByText('Page 1 of 2')).toBeVisible();
    await expect.poll(() => projectLoadRequests.length).toBe(2);
    expect(projectLoadRequests[1]).toEqual({
      path: project.absolutePath,
    });
    await historyModal.getByRole('button', { name: 'Close published version history' }).click();
    await expect(historyModal).toHaveCount(0);

    page.once('dialog', (dialog) => dialog.accept());
    await modal.getByRole('button', { name: 'Unpublish' }).click();
    await expect(modal.locator('.project-status-badge.unpublished')).toBeVisible({ timeout: 30_000 });
    await expect(modal.getByRole('button', { name: 'Delete project' })).toBeVisible();
  });
});
