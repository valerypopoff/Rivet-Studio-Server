import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const workflowsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-workflows-'));
process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;

const workflowMutations = await import('../routes/workflows/workflow-mutations.js');
const workflowQuery = await import('../routes/workflows/workflow-query.js');
const workflowFs = await import('../routes/workflows/fs-helpers.js');
const workflowPublication = await import('../routes/workflows/publication.js');
const workflowRoutes = await import('../routes/workflows/index.js');

async function resetWorkflowsRoot() {
  await fs.rm(workflowsRoot, { recursive: true, force: true });
  await fs.mkdir(workflowsRoot, { recursive: true });
}

test.beforeEach(async () => {
  await resetWorkflowsRoot();
  await workflowFs.ensureWorkflowsRoot();
});

async function withWorkflowApiServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use('/workflows', workflowRoutes.workflowsRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve test server address');
  }

  try {
    await run(`http://127.0.0.1:${address.port}/workflows`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

test('workflow project rename and move preserve wrapper sidecars', async () => {
  await workflowMutations.createWorkflowFolderItem('Folder', '');
  const created = await workflowMutations.createWorkflowProjectItem('', 'Example');
  const sidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);

  await fs.writeFile(sidecars.dataset, '{"rows":[]}', 'utf8');
  await fs.writeFile(sidecars.settings, '{"endpointName":""}', 'utf8');

  const renamed = await workflowMutations.renameWorkflowProjectItem(created.relativePath, 'Renamed');
  const renamedSidecars = workflowFs.getProjectSidecarPaths(renamed.project.absolutePath);

  assert.equal(await workflowFs.pathExists(renamedSidecars.dataset), true);
  assert.equal(await workflowFs.pathExists(renamedSidecars.settings), true);
  assert.deepEqual(renamed.movedProjectPaths, [
    {
      fromAbsolutePath: created.absolutePath,
      toAbsolutePath: renamed.project.absolutePath,
    },
  ]);

  const moved = await workflowQuery.moveWorkflowProject(workflowsRoot, renamed.project.relativePath, 'Folder');
  const movedSidecars = workflowFs.getProjectSidecarPaths(moved.project.absolutePath);

  assert.equal(await workflowFs.pathExists(movedSidecars.dataset), true);
  assert.equal(await workflowFs.pathExists(movedSidecars.settings), true);
});

test('workflow project rename rejects hidden names and does not expose hidden workflow paths', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Visible');

  await assert.rejects(
    workflowMutations.renameWorkflowProjectItem(created.relativePath, '.hidden'),
    /must not start with a dot/,
  );

  await assert.rejects(
    workflowMutations.createWorkflowFolderItem('.hidden', ''),
    /must not start with a dot/,
  );

  await assert.rejects(
    workflowMutations.deleteWorkflowFolderItem('.published'),
    /Invalid relativePath/,
  );
});

test('workflow project rename refuses conflicting sidecar targets without moving the project', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Source');
  const sourceSidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);
  const conflictingTargetPath = path.join(workflowsRoot, 'Target.rivet-project');
  const conflictingTargetSidecars = workflowFs.getProjectSidecarPaths(conflictingTargetPath);

  await fs.writeFile(sourceSidecars.dataset, '{"rows":[]}', 'utf8');
  await fs.writeFile(conflictingTargetSidecars.dataset, '{"stale":true}', 'utf8');

  await assert.rejects(
    workflowMutations.renameWorkflowProjectItem(created.relativePath, 'Target'),
    /Dataset file already exists/,
  );

  assert.equal(await workflowFs.pathExists(created.absolutePath), true);
  assert.equal(await workflowFs.pathExists(sourceSidecars.dataset), true);
  assert.equal(await workflowFs.pathExists(conflictingTargetPath), false);
});

test('workflow project move refuses conflicting sidecar targets without moving the project', async () => {
  await workflowMutations.createWorkflowFolderItem('Destination', '');
  const created = await workflowMutations.createWorkflowProjectItem('', 'Source');
  const sourceSidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);
  const conflictingTargetPath = path.join(workflowsRoot, 'Destination', 'Source.rivet-project');
  const conflictingTargetSidecars = workflowFs.getProjectSidecarPaths(conflictingTargetPath);

  await fs.writeFile(sourceSidecars.settings, '{"endpointName":"demo"}', 'utf8');
  await fs.writeFile(conflictingTargetSidecars.settings, '{"stale":true}', 'utf8');

  await assert.rejects(
    workflowQuery.moveWorkflowProject(workflowsRoot, created.relativePath, 'Destination'),
    /Settings file already exists/,
  );

  assert.equal(await workflowFs.pathExists(created.absolutePath), true);
  assert.equal(await workflowFs.pathExists(sourceSidecars.settings), true);
  assert.equal(await workflowFs.pathExists(conflictingTargetPath), false);
});

test('workflow folder rename handles case-only renames', async () => {
  const createdFolder = await workflowMutations.createWorkflowFolderItem('Folder', '');

  const renamedFolder = await workflowMutations.renameWorkflowFolderItem(createdFolder.relativePath, 'folder');

  assert.equal(renamedFolder.name, 'folder');
  assert.equal(renamedFolder.relativePath, 'folder');
  assert.equal(await workflowFs.pathExists(path.join(workflowsRoot, 'folder')), true);
});

test('workflow project stats count serialized graph nodes', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Stats');
  const projectContents = await fs.readFile(created.absolutePath, 'utf8');
  const withNode = projectContents.replace(
    '      nodes: {}',
    [
      '      nodes:',
      '        \'[node-1]:text "Node 1"\':',
      '          visualData: 0/0/null/null//',
      '          data:',
      '            text: hello',
    ].join('\n'),
  );

  await fs.writeFile(created.absolutePath, withNode, 'utf8');

  const project = await workflowQuery.getWorkflowProject(workflowsRoot, created.absolutePath);

  assert.equal(project.stats?.graphCount, 1);
  assert.equal(project.stats?.totalNodeCount, 1);
});

test('workflow routes support folder/project create, move, rename, and delete flows over HTTP', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdFolder = await readJson<{ folder: { relativePath: string } }>(await fetch(`${baseUrl}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Folder' }),
    }));

    const createdProject = await readJson<{ project: { relativePath: string; absolutePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderRelativePath: createdFolder.folder.relativePath, name: 'Example' }),
    }));

    const movedProject = await readJson<{ project: { relativePath: string }; movedProjectPaths: Array<{ fromAbsolutePath: string; toAbsolutePath: string }> }>(
      await fetch(`${baseUrl}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemType: 'project',
          sourceRelativePath: createdProject.project.relativePath,
          destinationFolderRelativePath: '',
        }),
      }),
    );

    assert.equal(movedProject.project.relativePath, 'Example.rivet-project');
    assert.equal(movedProject.movedProjectPaths.length, 1);

    const renamedProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: movedProject.project.relativePath,
        newName: 'Renamed',
      }),
    }));

    assert.equal(renamedProject.project.relativePath, 'Renamed.rivet-project');

    const tree = await readJson<{ folders: Array<{ relativePath: string }>; projects: Array<{ relativePath: string }> }>(
      await fetch(`${baseUrl}/tree`),
    );

    assert.deepEqual(tree.folders.map((folder) => folder.relativePath), ['Folder']);
    assert.deepEqual(tree.projects.map((project) => project.relativePath), ['Renamed.rivet-project']);

    const deleteProjectResponse = await readJson<{ deleted: true }>(await fetch(`${baseUrl}/projects`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: 'Renamed.rivet-project' }),
    }));
    assert.equal(deleteProjectResponse.deleted, true);

    const deleteFolderResponse = await readJson<{ deleted: true }>(await fetch(`${baseUrl}/folders`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdFolder.folder.relativePath }),
    }));
    assert.equal(deleteFolderResponse.deleted, true);
  });
});

test('publish and unpublish keep workflow project behavior stable', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Published');

  const published = await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'demo-endpoint',
  });

  assert.equal(published.settings.status, 'published');
  assert.equal(published.settings.endpointName, 'demo-endpoint');
  assert.equal(await workflowFs.pathExists(path.join(workflowsRoot, '.published')), true);

  const unpublished = await workflowMutations.unpublishWorkflowProjectItem(created.relativePath);
  assert.equal(unpublished.settings.status, 'unpublished');
  assert.equal(unpublished.settings.endpointName, 'demo-endpoint');
});

test('workflow publish and unpublish routes preserve publication state over HTTP', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Published' }),
    }));

    const published = await readJson<{ project: { settings: { status: string; endpointName: string } } }>(
      await fetch(`${baseUrl}/projects/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          relativePath: createdProject.project.relativePath,
          settings: { endpointName: 'http-endpoint' },
        }),
      }),
    );

    assert.equal(published.project.settings.status, 'published');
    assert.equal(published.project.settings.endpointName, 'http-endpoint');

    const unpublished = await readJson<{ project: { settings: { status: string; endpointName: string } } }>(
      await fetch(`${baseUrl}/projects/unpublish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: createdProject.project.relativePath }),
      }),
    );

    assert.equal(unpublished.project.settings.status, 'unpublished');
    assert.equal(unpublished.project.settings.endpointName, 'http-endpoint');
  });
});

test('publish enforces case-insensitive endpoint uniqueness', async () => {
  const firstProject = await workflowMutations.createWorkflowProjectItem('', 'First');
  const secondProject = await workflowMutations.createWorkflowProjectItem('', 'Second');

  await workflowMutations.publishWorkflowProjectItem(firstProject.relativePath, {
    endpointName: 'Demo-Endpoint',
  });

  await assert.rejects(
    workflowMutations.publishWorkflowProjectItem(secondProject.relativePath, {
      endpointName: 'demo-endpoint',
    }),
    /Endpoint name is already used/,
  );
});

test('published and latest workflow resolution split after unpublished changes', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Resolution');
  const sidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);

  await fs.writeFile(sidecars.dataset, '{"before":true}', 'utf8');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'resolution-endpoint',
  });

  await fs.writeFile(created.absolutePath, `${await fs.readFile(created.absolutePath, 'utf8')}\n# changed\n`, 'utf8');
  await fs.writeFile(sidecars.dataset, '{"after":true}', 'utf8');

  const publishedMatch = await workflowPublication.findPublishedWorkflowByEndpoint(workflowsRoot, 'resolution-endpoint');
  const latestMatch = await workflowPublication.findLatestWorkflowByEndpoint(workflowsRoot, 'resolution-endpoint');
  const currentSettings = await workflowPublication.getWorkflowProjectSettings(created.absolutePath, created.name);
  const storedSettings = await workflowPublication.readStoredWorkflowProjectSettings(created.absolutePath, created.name);

  assert.ok(publishedMatch);
  assert.ok(latestMatch);
  assert.ok(storedSettings.publishedSnapshotId);
  assert.equal(latestMatch.projectPath, created.absolutePath);
  assert.notEqual(publishedMatch.publishedProjectPath, created.absolutePath);
  assert.equal(currentSettings.status, 'unpublished_changes');

  const publishedContents = await fs.readFile(publishedMatch.publishedProjectPath, 'utf8');
  const latestContents = await fs.readFile(latestMatch.projectPath, 'utf8');
  const publishedDatasetContents = await fs.readFile(
    workflowFs.getPublishedWorkflowSnapshotDatasetPath(
      workflowsRoot,
      storedSettings.publishedSnapshotId,
    ),
    'utf8',
  );

  assert.notEqual(publishedContents, latestContents);
  assert.equal(publishedDatasetContents, '{"before":true}');
});

test('delete workflow project removes project and sidecars', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DeleteMe');
  const sidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);
  await fs.writeFile(sidecars.dataset, '{}', 'utf8');
  await fs.writeFile(sidecars.settings, '{}', 'utf8');

  await workflowMutations.deleteWorkflowProjectItem(created.relativePath);

  assert.equal(await workflowFs.pathExists(created.absolutePath), false);
  assert.equal(await workflowFs.pathExists(sidecars.dataset), false);
  assert.equal(await workflowFs.pathExists(sidecars.settings), false);
});

test('delete workflow project removes published snapshots', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DeletePublished');
  const published = await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'delete-published',
  });
  const storedSettings = await workflowPublication.readStoredWorkflowProjectSettings(published.absolutePath, published.name);
  const publishedSnapshotPath = workflowFs.getPublishedWorkflowSnapshotPath(workflowsRoot, storedSettings.publishedSnapshotId!);

  assert.equal(await workflowFs.pathExists(publishedSnapshotPath), true);

  await workflowMutations.deleteWorkflowProjectItem(created.relativePath);

  assert.equal(await workflowFs.pathExists(publishedSnapshotPath), false);
});
