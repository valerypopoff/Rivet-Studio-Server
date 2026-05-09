import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

test.describe('Workflow library layout', () => {
  test('keeps the left panel header toggle in a persistent narrow rail', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const sidebar = page.locator('.dashboard-sidebar');
    const header = page.locator('.workflow-library-panel .header');
    await expect(header).toBeVisible();

    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(Math.round(headerBox!.height)).toBe(37);

    const collapseButton = page.getByRole('button', { name: 'Collapse folders pane' });
    const title = page.locator('.workflow-library-panel .header-title');
    await expect(collapseButton).toBeVisible();
    await expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
    await expect(collapseButton.locator('path').last()).toHaveAttribute('d', 'M5.25 4.75v6.5');

    const collapseButtonBox = await collapseButton.boundingBox();
    const titleBox = await title.boundingBox();
    expect(collapseButtonBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(collapseButtonBox!.x).toBeLessThan(titleBox!.x);

    await collapseButton.click();

    const expandButton = page.getByRole('button', { name: 'Expand folders pane' });
    await expect(expandButton).toBeVisible();
    await expect(expandButton).toHaveAttribute('aria-expanded', 'false');
    await expect(expandButton.locator('path').last()).toHaveAttribute('d', 'M7.25 4.75v6.5');
    await expect(title).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show main panel' })).toHaveCount(0);
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(37);

    await expandButton.click();

    await expect(page.getByRole('button', { name: 'Collapse folders pane' })).toBeVisible();
    await expect(title).toHaveText('Rivet Projects');
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBeGreaterThan(200);
  });
});
