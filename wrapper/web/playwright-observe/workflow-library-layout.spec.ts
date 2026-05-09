import { expect, test } from '@playwright/test';
import { authenticateIfNeeded } from './helpers/hostedEditorObserve';

test.describe('Workflow library layout', () => {
  test('keeps the left panel header at the dashboard chrome height', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);

    const header = page.locator('.workflow-library-panel .header');
    await expect(header).toBeVisible();

    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(Math.round(headerBox!.height)).toBe(37);
  });
});
