import { expect, test } from '@playwright/test';
import {
  authenticateIfNeeded,
  findBlankCanvasPoint,
  getVisibleNodeCenters,
  saveStepScreenshot,
  waitForDashboardReady,
  waitForFocusTag,
  waitForNodeCountIncrease,
} from './helpers/hostedEditorObserve';

const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('Observable hosted editor flow', () => {
  test('shows focus handoff and clipboard recovery in real time', async ({ page }, testInfo) => {
    test.slow();

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await saveStepScreenshot(page, testInfo, '01-dashboard-ready.png');

    const firstFolder = page.locator('.folder-row').first();
    await expect(firstFolder, 'Need at least one workflow folder to run the observable hosted-editor flow').toBeVisible({
      timeout: 120_000,
    });

    const iframe = page.locator('iframe.dashboard-editor-frame');
    const frameLocator = page.frameLocator('iframe.dashboard-editor-frame');
    const canvas = frameLocator.locator('.node-canvas');
    const nodes = frameLocator.locator('.node');
    let openedProjectRow = page.locator('.project-row').first();

    await test.step('Expand the first folder and open the first project with a visible graph', async () => {
      await firstFolder.click();
      const projectRows = page.locator('.project-row');
      const projectCount = await projectRows.count();
      expect(projectCount, 'Need at least one workflow project in the first folder').toBeGreaterThan(0);

      let openedProjectIndex = -1;
      for (let index = 0; index < Math.min(projectCount, 5); index += 1) {
        const candidate = projectRows.nth(index);
        await expect(candidate, 'Need a visible workflow project row to open in the observable flow').toBeVisible({
          timeout: 30_000,
        });
        await candidate.scrollIntoViewIfNeeded();
        await candidate.dblclick();

        await expect(iframe).toBeVisible({ timeout: 30_000 });
        await expect(canvas).toBeVisible({ timeout: 30_000 });

        try {
          await expect(nodes.first()).toBeVisible({ timeout: 10_000 });
          openedProjectIndex = index;
          break;
        } catch {
          // Try the next visible project. Some environments keep scratch or empty projects at the top.
        }
      }

      expect(openedProjectIndex, 'Need a visible project graph for the observable hosted-editor flow').toBeGreaterThanOrEqual(0);
      openedProjectRow = projectRows.nth(openedProjectIndex);
      await expect(openedProjectRow).toBeVisible({
        timeout: 30_000,
      });
    });

    await expect(iframe).toBeVisible({ timeout: 120_000 });
    await expect(canvas).toBeVisible({ timeout: 120_000 });
    await expect(nodes.first()).toBeVisible({ timeout: 120_000 });

    const focusAfterOpen = await waitForFocusTag(page, 'IFRAME', 'project open');
    const iframeStyles = await iframe.evaluate((node) => {
      const styles = getComputedStyle(node);
      return {
        outlineStyle: styles.outlineStyle,
        outlineWidth: styles.outlineWidth,
        outlineColor: styles.outlineColor,
        boxShadow: styles.boxShadow,
        borderTopStyle: styles.borderTopStyle,
        borderTopWidth: styles.borderTopWidth,
      };
    });

    expect(focusAfterOpen.tag).toBe('IFRAME');
    expect(iframeStyles.outlineWidth).toBe('0px');
    expect(iframeStyles.boxShadow).toBe('none');
    expect(iframeStyles.borderTopWidth).toBe('0px');
    await saveStepScreenshot(page, testInfo, '02-editor-opened.png');

    const sidebarBox = await page.locator('.dashboard-sidebar').boundingBox();
    expect(sidebarBox).not.toBeNull();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    const minVisibleX = sidebarBox!.x + sidebarBox!.width;
    const maxVisibleX = viewport!.width;
    const maxVisibleY = viewport!.height;
    const visibleNodeCenters = await getVisibleNodeCenters(nodes, minVisibleX, maxVisibleX, maxVisibleY);
    expect(visibleNodeCenters.length).toBeGreaterThanOrEqual(2);

    await test.step('Return focus to the sidebar and recover it with Shift+click node selection', async () => {
      await page.mouse.click(visibleNodeCenters[0]!.x, visibleNodeCenters[0]!.y);
      await openedProjectRow.click();
      await waitForFocusTag(page, 'BUTTON', 'sidebar refocus');
      await saveStepScreenshot(page, testInfo, '03-sidebar-refocus.png');

      await page.keyboard.down('Shift');
      await page.mouse.click(visibleNodeCenters[1]!.x, visibleNodeCenters[1]!.y);
      await page.keyboard.up('Shift');
    });

    const focusAfterShiftClick = await waitForFocusTag(page, 'IFRAME', 'shift-click recovery');
    expect(focusAfterShiftClick.tag).toBe('IFRAME');

    const nodeCountBeforeFirstPaste = await nodes.count();
    await page.keyboard.press(`${shortcutModifier}+C`);
    await page.keyboard.press(`${shortcutModifier}+V`);
    const nodeCountAfterFirstPaste = await waitForNodeCountIncrease(nodes, nodeCountBeforeFirstPaste, 'shift-click paste');
    expect(nodeCountAfterFirstPaste).toBeGreaterThan(nodeCountBeforeFirstPaste);
    await saveStepScreenshot(page, testInfo, '04-after-shift-paste.png');

    await test.step('Return focus to the sidebar again and recover it with a blank-canvas click', async () => {
      await openedProjectRow.click();
      await waitForFocusTag(page, 'BUTTON', 'sidebar refocus before blank canvas');

      const blankPoint = await findBlankCanvasPoint(canvas, nodes, minVisibleX, maxVisibleX, maxVisibleY);
      expect(blankPoint, 'Need a visible blank point on the node canvas for the observable blank-canvas recovery step').not.toBeNull();
      await page.mouse.click(blankPoint!.x, blankPoint!.y);
    });

    const focusAfterBlankCanvasClick = await waitForFocusTag(page, 'IFRAME', 'blank-canvas recovery');
    expect(focusAfterBlankCanvasClick.tag).toBe('IFRAME');

    const nodeCountBeforeSecondPaste = await nodes.count();
    await page.keyboard.press(`${shortcutModifier}+V`);
    const nodeCountAfterSecondPaste = await waitForNodeCountIncrease(nodes, nodeCountBeforeSecondPaste, 'blank-canvas paste');
    expect(nodeCountAfterSecondPaste).toBeGreaterThan(nodeCountBeforeSecondPaste);
    await saveStepScreenshot(page, testInfo, '05-after-blank-canvas-paste.png');
  });
});
