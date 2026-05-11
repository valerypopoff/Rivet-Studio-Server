import { expect, test } from '@playwright/test';
import { authenticateIfNeeded } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('hosted editor project tabs show only the project title', async ({ page }) => {
  const projectId = 'tab-label-project';
  const graphId = 'tab-label-graph';
  const projectTitle = 'Tab Label Project';

  await seedHostedEditorProject(page, {
    graphId,
    projectId,
    projectPath: `/workflows/${projectTitle}.rivet-project`,
    title: projectTitle,
  });

  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);

  const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');
  const tab = editorFrame.locator('.project.active .project-name').first();
  await expect(tab).toHaveText(projectTitle);
  await expect(tab).not.toContainText('.rivet-project');
});

test('hosted editor project tab updates to the file-tree title after save', async ({ page }) => {
  const projectId = 'save-title-project';
  const graphId = 'save-title-graph';
  const editorTitle = 'Editor Settings Name';
  const fileTreeTitle = 'File Tree Name';
  const projectPath = `/workflows/${fileTreeTitle}.rivet-project`;
  let saveRequestCount = 0;

  await page.route('**/api/projects/save', async (route) => {
    saveRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        path: projectPath,
        revisionId: null,
        project: null,
        created: false,
      }),
    });
  });

  await seedHostedEditorProject(page, {
    graphId,
    loaded: true,
    projectId,
    projectPath,
    title: editorTitle,
  });

  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);

  const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');
  const tab = editorFrame.locator('.project.active .project-name').first();
  await expect(tab).toHaveText(editorTitle);
  const canvas = editorFrame.locator('.node-canvas');
  await expect(canvas).toBeVisible();

  await canvas.click();
  await page.keyboard.press('Control+S');

  await expect.poll(() => saveRequestCount).toBe(1);
  await expect(tab).toHaveText(fileTreeTitle);
  await expect(editorFrame.locator('.project')).toHaveCount(1);
  await expect(canvas).toBeVisible();
});
