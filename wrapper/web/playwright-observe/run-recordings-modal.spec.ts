import { expect, test } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

function createSerializedRecording(recordingId: string): string {
  const timestamp = Date.now();

  return JSON.stringify({
    version: 1,
    recording: {
      recordingId,
      startTs: timestamp,
      finishTs: timestamp,
      events: [
        {
          type: 'done',
          data: { results: { output: 'ok' } },
          ts: timestamp,
        },
      ],
    },
    assets: {},
    strings: {},
  });
}

test.describe('Run recordings modal', () => {
  test('workflow selection, filters, pagination, open, and delete flows stay wired correctly', async ({ page }) => {
    test.slow();

    const recordingFetches: string[] = [];
    const workflows = [
      {
        workflowId: 'workflow-a',
        project: {
          id: 'workflow-a',
          name: 'Published Flow',
          fileName: 'Published Flow.rivet-project',
          relativePath: 'Published Flow.rivet-project',
          absolutePath: '/workflows/Published Flow.rivet-project',
          updatedAt: '2026-04-08T10:00:00.000Z',
          settings: {
            status: 'published',
            endpointName: 'published-flow',
            lastPublishedAt: '2026-04-08T09:30:00.000Z',
          },
        },
        latestRunAt: '2026-04-08T09:45:00.000Z',
        totalRuns: 2,
        failedRuns: 1,
        suspiciousRuns: 0,
      },
      {
        workflowId: 'workflow-b',
        project: {
          id: 'workflow-b',
          name: 'Latest Flow',
          fileName: 'Latest Flow.rivet-project',
          relativePath: 'Folder/Latest Flow.rivet-project',
          absolutePath: '/workflows/Folder/Latest Flow.rivet-project',
          updatedAt: '2026-04-08T11:00:00.000Z',
          settings: {
            status: 'unpublished_changes',
            endpointName: 'latest-flow',
            lastPublishedAt: '2026-04-08T08:15:00.000Z',
          },
        },
        latestRunAt: '2026-04-08T11:30:00.000Z',
        totalRuns: 12,
        failedRuns: 2,
        suspiciousRuns: 1,
      },
    ];
    const runsByWorkflow = new Map([
      ['workflow-a', [
        {
          id: 'recording-a-1',
          workflowId: 'workflow-a',
          createdAt: '2026-04-08T09:45:00.000Z',
          runKind: 'published',
          status: 'failed',
          durationMs: 1400,
          endpointNameAtExecution: 'published-flow',
          errorMessage: 'Boom',
          hasReplayDataset: false,
          recordingCompressedBytes: 10,
          recordingUncompressedBytes: 20,
          projectCompressedBytes: 10,
          projectUncompressedBytes: 20,
          datasetCompressedBytes: 0,
          datasetUncompressedBytes: 0,
        },
        {
          id: 'recording-a-2',
          workflowId: 'workflow-a',
          createdAt: '2026-04-08T09:40:00.000Z',
          runKind: 'published',
          status: 'succeeded',
          durationMs: 1200,
          endpointNameAtExecution: 'published-flow',
          hasReplayDataset: false,
          recordingCompressedBytes: 10,
          recordingUncompressedBytes: 20,
          projectCompressedBytes: 10,
          projectUncompressedBytes: 20,
          datasetCompressedBytes: 0,
          datasetUncompressedBytes: 0,
        },
      ]],
      ['workflow-b', Array.from({ length: 12 }, (_, index) => ({
        id: `recording-b-${index + 1}`,
        workflowId: 'workflow-b',
        createdAt: new Date(Date.UTC(2026, 3, 8, 11, 30 - index, 0)).toISOString(),
        runKind: index % 3 === 0 ? 'latest' : 'published',
        status: index === 1 || index === 7 ? 'failed' : index === 4 ? 'suspicious' : 'succeeded',
        durationMs: 900 + (index * 10),
        endpointNameAtExecution: 'latest-flow',
        errorMessage: index === 1 || index === 7 ? 'Failure' : undefined,
        hasReplayDataset: false,
        recordingCompressedBytes: 10,
        recordingUncompressedBytes: 20,
        projectCompressedBytes: 10,
        projectUncompressedBytes: 20,
        datasetCompressedBytes: 0,
        datasetUncompressedBytes: 0,
      }))],
    ]);

    await page.addInitScript(() => {
      window.confirm = () => true;
    });

    await page.route('**/api/workflows/recordings/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const parts = url.pathname.split('/').filter(Boolean);

      if (request.method() === 'GET' && url.pathname.endsWith('/workflows')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ workflows }),
        });
        return;
      }

      if (request.method() === 'GET' && parts.includes('runs')) {
        const workflowId = parts[parts.length - 2]!;
        const status = (url.searchParams.get('status') ?? 'all') as 'all' | 'failed';
        const pageNumber = Number(url.searchParams.get('page') ?? '1');
        const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
        const sourceRuns = runsByWorkflow.get(workflowId) ?? [];
        const filteredRuns = status === 'failed'
          ? sourceRuns.filter((run) => run.status === 'failed' || run.status === 'suspicious')
          : sourceRuns;
        const pageRuns = filteredRuns.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            workflowId,
            page: pageNumber,
            pageSize,
            totalRuns: filteredRuns.length,
            statusFilter: status,
            runs: pageRuns,
          }),
        });
        return;
      }

      if (request.method() === 'DELETE' && parts.length >= 4) {
        const recordingId = decodeURIComponent(parts[3]!);
        for (const [workflowId, runs] of runsByWorkflow.entries()) {
          const nextRuns = runs.filter((run) => run.id !== recordingId);
          if (nextRuns.length !== runs.length) {
            runsByWorkflow.set(workflowId, nextRuns);
            const workflow = workflows.find((entry) => entry.workflowId === workflowId);
            if (workflow) {
              workflow.totalRuns = nextRuns.length;
              workflow.failedRuns = nextRuns.filter((run) => run.status === 'failed').length;
              workflow.suspiciousRuns = nextRuns.filter((run) => run.status === 'suspicious').length;
              workflow.latestRunAt = nextRuns[0]?.createdAt;
            }
            break;
          }
        }

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ deleted: true }),
        });
        return;
      }

      if (request.method() === 'GET' && parts.length >= 5 && parts[4] === 'recording') {
        const recordingId = decodeURIComponent(parts[3]!);
        recordingFetches.push(recordingId);
        await route.fulfill({
          status: 200,
          contentType: 'text/plain; charset=utf-8',
          body: createSerializedRecording(recordingId),
        });
        return;
      }

      await route.fallback();
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    await page.getByRole('button', { name: 'Run recordings' }).click();
    const modal = page.getByTestId('run-recordings-modal');
    await expect(modal).toBeVisible();

    await modal.locator('.run-recordings-select__control').click();
    await page.locator('.run-recordings-select__option', { hasText: 'Latest Flow' }).click();
    await expect(modal.locator('.run-recordings-workflow-name')).toHaveText('Latest Flow');

    await modal.getByRole('button', { name: /Bad only/ }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(3);

    await modal.getByRole('button', { name: /^All/ }).click();
    await modal.getByRole('button', { name: '10', exact: true }).click();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 1 of 2');

    const firstRun = modal.locator('.run-recordings-run').first();
    await firstRun.hover();
    await firstRun.locator('.run-recordings-run-delete-button').click();
    await expect(modal.locator('.run-recordings-page-status')).toHaveText('Page 1 of 2');
    await expect(modal.locator('.run-recordings-run')).toHaveCount(10);

    await modal.locator('.run-recordings-run').first().locator('.run-recordings-run-open-button').click();
    await expect.poll(() => recordingFetches.length).toBe(1);
  });
});
