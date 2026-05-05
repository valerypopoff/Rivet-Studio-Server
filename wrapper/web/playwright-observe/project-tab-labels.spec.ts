import { expect, test } from '@playwright/test';

test('hosted editor project tabs show only the project title', async ({ page }) => {
  const projectId = 'tab-label-project';
  const graphId = 'tab-label-graph';
  const projectTitle = 'Tab Label Project';

  await page.addInitScript(
    ({ graphId: seededGraphId, projectId: seededProjectId, projectTitle: seededProjectTitle }) => {
      localStorage.setItem(
        'project',
        JSON.stringify({
          projectState: {
            metadata: {
              id: seededProjectId,
              title: seededProjectTitle,
              description: '',
              mainGraphId: seededGraphId,
            },
            graphs: {
              [seededGraphId]: {
                metadata: {
                  id: seededGraphId,
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
              [seededProjectId]: {
                projectId: seededProjectId,
                title: seededProjectTitle,
                fsPath: `/workflows/${seededProjectTitle}.rivet-project`,
                openedGraph: seededGraphId,
              },
            },
            openedProjectsSortedIds: [seededProjectId],
          },
          openedProjectSnapshotsState: {},
        }),
      );
    },
    { graphId, projectId, projectTitle },
  );

  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });

  const tab = page.locator('.project.active .project-name').first();
  await expect(tab).toHaveText(projectTitle);
  await expect(tab).not.toContainText('.rivet-project');
});
