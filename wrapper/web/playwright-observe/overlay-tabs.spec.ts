import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

test.describe('Overlay tabs', () => {
  test('toggle overlay panels through the shared menu config', async ({ page }) => {
    test.slow();

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const firstFolder = page.locator('.folder-row').first();
    await expect(firstFolder).toBeVisible({ timeout: 120_000 });
    await firstFolder.click();

    const firstProject = page.locator('.project-row').first();
    await expect(firstProject).toBeVisible({ timeout: 30_000 });
    await firstProject.dblclick();

    const iframe = page.locator('iframe.dashboard-editor-frame');
    await expect(iframe).toBeVisible({ timeout: 120_000 });

    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    const canvasTab = frame.locator('.menu-item.canvas-menu');
    const pluginsTab = frame.locator('.menu-item.plugins');
    const dataStudioTab = frame.locator('.menu-item.data-studio');

    await expect(canvasTab).toHaveClass(/active/);

    await frame.getByRole('button', { name: 'Plugins' }).click();
    await expect(pluginsTab).toHaveClass(/active/);

    await frame.getByRole('button', { name: 'Plugins' }).click();
    await expect(canvasTab).toHaveClass(/active/);

    await frame.getByRole('button', { name: 'Data Studio' }).click();
    await expect(dataStudioTab).toHaveClass(/active/);
  });
});
