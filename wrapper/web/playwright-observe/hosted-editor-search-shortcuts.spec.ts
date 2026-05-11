import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady, waitForFocusTag } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test('dashboard-focused Ctrl+F opens Rivet search instead of browser find', async ({ page }) => {
  await seedHostedEditorProject(page, {
    graphId: 'search-shortcut-graph',
    loaded: true,
    projectId: 'search-shortcut-project',
    projectPath: '/workflows/Search Shortcut Project.rivet-project',
    title: 'Search Shortcut Project',
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const frameLocator = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(frameLocator.locator('.node-canvas')).toBeVisible({ timeout: 60_000 });

  const collapseButton = page.getByRole('button', { name: 'Collapse folders pane' });
  await collapseButton.focus();
  await waitForFocusTag(page, 'BUTTON', 'dashboard shortcut source');

  await page.keyboard.press(`${shortcutModifier}+F`);
  const graphSearchInput = frameLocator.locator('.search input[placeholder="Search..."]');
  await expect(graphSearchInput).toBeVisible();
  await expect(graphSearchInput).toBeFocused();

  await graphSearchInput.press('Escape');
  await expect(graphSearchInput).toBeHidden();
});
