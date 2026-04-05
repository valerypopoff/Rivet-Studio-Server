import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { requireManagedMutationOptIn } from './helpers/workflowLibraryObserve';

test.describe('Runtime library job cancellation', () => {
  test('cancel keeps the terminal failed state visible and does not duplicate streamed logs', async ({ page }) => {
    test.slow();
    requireManagedMutationOptIn();

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    const modal = page.locator('[data-testid="runtime-libraries-modal"]');

    const runtimeLibrariesButton = page.getByRole('button', { name: 'Runtime libraries' });
    await expect(runtimeLibrariesButton).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2_000);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runtimeLibrariesButton.click({ force: true });
      try {
        await modal.waitFor({ state: 'visible', timeout: 5_000 });
        break;
      } catch (error) {
        if (attempt === 2) {
          throw error;
        }
        await page.waitForTimeout(1_000);
      }
    }

    const addButton = modal.getByRole('button', { name: 'Add library...' });
    if (await addButton.count()) {
      await addButton.click({ force: true });
    }

    await modal.locator('#runtime-library-package-name').fill('sharp');
    await modal.locator('#runtime-library-package-version').fill('latest');
    await modal.getByRole('button', { name: 'Install' }).click();

    await modal.locator('.runtime-libraries-log-panel').waitFor({ state: 'visible', timeout: 30_000 });
    await modal.locator('.runtime-libraries-log-line').first().waitFor({ state: 'visible', timeout: 30_000 });

    await page.waitForTimeout(1_500);
    await modal.getByRole('button', { name: 'Cancel job' }).click();

    const failedStatus = modal.locator('.runtime-libraries-status.failed');
    await expect(failedStatus).toBeVisible({ timeout: 30_000 });
    await expect(failedStatus).toContainText('Cancelled by user');

    const logText = await modal.locator('.runtime-libraries-log-panel').textContent();
    expect((logText?.match(/--- Starting install job ---/g) ?? []).length).toBe(1);
    expect((logText?.match(/Running npm install\.\.\./g) ?? []).length).toBe(1);
  });
});
