import { expect, type Page, test } from '@playwright/test';

type SeedProjectOptions = {
  graphId: string;
  loaded?: boolean;
  projectId: string;
  projectPath: string;
  title: string;
};

async function seedHostedProjectTab(page: Page, options: SeedProjectOptions) {
  await page.addInitScript((seed: SeedProjectOptions) => {
    localStorage.setItem(
      'project',
      JSON.stringify({
        ...(seed.loaded
          ? {
              loadedProjectState: {
                loaded: true,
                path: seed.projectPath,
              },
            }
          : {}),
        projectState: {
          metadata: {
            id: seed.projectId,
            title: seed.title,
            description: '',
            mainGraphId: seed.graphId,
          },
          graphs: {
            [seed.graphId]: {
              metadata: {
                id: seed.graphId,
                name: 'Main Graph',
                description: '',
              },
              nodes: [],
              connections: [],
            },
          },
          plugins: [],
        },
        projectsState: {
          openedProjects: {
            [seed.projectId]: {
              projectId: seed.projectId,
              title: seed.title,
              fsPath: seed.projectPath,
              openedGraph: seed.graphId,
            },
          },
          openedProjectsSortedIds: [seed.projectId],
        },
        openedProjectSnapshotsState: {},
      }),
    );
  }, options);
}

test('hosted editor project tabs show only the project title', async ({ page }) => {
  const projectId = 'tab-label-project';
  const graphId = 'tab-label-graph';
  const projectTitle = 'Tab Label Project';

  await seedHostedProjectTab(page, {
    graphId,
    projectId,
    projectPath: `/workflows/${projectTitle}.rivet-project`,
    title: projectTitle,
  });

  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });

  const tab = page.locator('.project.active .project-name').first();
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

  await seedHostedProjectTab(page, {
    graphId,
    loaded: true,
    projectId,
    projectPath,
    title: editorTitle,
  });

  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });

  const tab = page.locator('.project.active .project-name').first();
  await expect(tab).toHaveText(editorTitle);
  await expect(page.locator('.node-canvas')).toBeVisible();

  await page.keyboard.press('Control+S');

  await expect.poll(() => saveRequestCount).toBe(1);
  await expect(tab).toHaveText(fileTreeTitle);
  await expect(page.locator('.project')).toHaveCount(1);
  await expect(page.locator('.node-canvas')).toBeVisible();
});
