import { expect, test } from '@playwright/test';

test.describe('Hosted editor File menu', () => {
  test('shows only graph import/export and settings actions', async ({ page }) => {
    await page.goto('/?editor=1', { waitUntil: 'domcontentloaded' });

    const fileButton = page.getByRole('button', { name: 'File', exact: true });
    await expect(fileButton).toBeVisible({ timeout: 120_000 });

    await fileButton.click();

    const fileMenu = page.getByRole('menu');
    await expect(fileMenu).toBeVisible();
    await expect(fileMenu.getByRole('menuitem')).toHaveText([
      'Import graph',
      'Export graph',
      'Settings',
    ]);
    await expect(fileMenu.getByRole('separator')).toHaveCount(1);
  });
});
