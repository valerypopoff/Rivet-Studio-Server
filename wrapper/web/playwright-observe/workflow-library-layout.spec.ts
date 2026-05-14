import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

const rootPackageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

test.describe('Workflow library layout', () => {
  test('collapses from the full header row into a clickable narrow rail', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const sidebar = page.locator('.dashboard-sidebar');
    const header = page.locator('.workflow-library-panel .header');
    await expect(header).toBeVisible();

    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(Math.round(headerBox!.height)).toBe(37);
    await expect(header).toHaveCSS('border-bottom-width', '0px');

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

    const bottomActions = page.locator('.workflow-library-panel .panel-bottom-actions');
    await expect(bottomActions).toHaveCSS('padding-bottom', '24px');

    await page.getByRole('button', { name: 'About' }).click();
    const aboutModal = page.locator('[data-testid="about-modal"]');
    await expect(aboutModal).toBeVisible();
    await expect(aboutModal).toContainText('Rivet Studio Server');
    await expect(aboutModal).toContainText('Version');
    await expect(aboutModal).toContainText(rootPackageJson.version);
    await page.getByRole('button', { name: 'Close about' }).click();
    await expect(aboutModal).toHaveCount(0);

    await header.click({ position: { x: headerBox!.width - 8, y: headerBox!.height / 2 } });

    const expandButton = page.getByRole('button', { name: 'Expand folders pane' });
    await expect(expandButton).toBeVisible();
    await expect(expandButton).toHaveAttribute('aria-expanded', 'false');
    await expect(expandButton.locator('path')).toHaveAttribute('d', 'M6 4.5 9.5 8 6 11.5');
    await expect(header).toHaveCount(1);
    await expect(title).toHaveCount(1);
    await expect(header).toBeHidden();
    await expect(title).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show main panel' })).toHaveCount(0);

    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(30);
    const sidebarBox = await sidebar.boundingBox();
    const expandButtonBox = await expandButton.boundingBox();
    const expandIconBox = await expandButton.locator('svg').boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(expandButtonBox).not.toBeNull();
    expect(expandIconBox).not.toBeNull();
    expect(Math.round(expandButtonBox!.width)).toBe(Math.round(sidebarBox!.width));
    expect(Math.round(expandButtonBox!.height)).toBe(Math.round(sidebarBox!.height));
    expect(Math.abs((expandIconBox!.y + expandIconBox!.height / 2) - (sidebarBox!.y + sidebarBox!.height / 2))).toBeLessThan(2);

    await page.mouse.click(sidebarBox!.x + sidebarBox!.width / 2, sidebarBox!.y + sidebarBox!.height - 20);

    const titleVisibilityDuringExpand = await title.evaluate((element) => window.getComputedStyle(element).visibility);
    expect(titleVisibilityDuringExpand).toBe('hidden');
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBeGreaterThan(200);
    await expect(page.getByRole('button', { name: 'Collapse folders pane' })).toBeVisible();
    await expect(title).toBeVisible();
    await expect(title).toHaveText('Rivet Projects');
  });
});
