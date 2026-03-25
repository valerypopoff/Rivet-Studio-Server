import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const workflowsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-workflows-'));
const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-app-data-'));
process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
process.env.RIVET_APP_DATA_ROOT = appDataRoot;

const workflowMutations = await import('../routes/workflows/workflow-mutations.js');
const workflowQuery = await import('../routes/workflows/workflow-query.js');
const workflowFs = await import('../routes/workflows/fs-helpers.js');
const workflowPublication = await import('../routes/workflows/publication.js');
const workflowRecordings = await import('../routes/workflows/recordings.js');
const workflowExecution = await import('../routes/workflows/execution.js');
const workflowRoutes = await import('../routes/workflows/index.js');
const rivetNode = await import('@ironclad/rivet-node');

async function resetWorkflowsRoot() {
  await workflowRecordings.resetWorkflowRecordingStorageForTests();
  await fs.rm(workflowsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await fs.mkdir(workflowsRoot, { recursive: true });
  await fs.rm(appDataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await fs.mkdir(appDataRoot, { recursive: true });
}

test.beforeEach(async () => {
  await resetWorkflowsRoot();
  await workflowFs.ensureWorkflowsRoot();
});

async function withWorkflowApiServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json({ strict: false }));
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

async function withWorkflowExecutionServer(
  run: (urls: { apiBaseUrl: string; publishedBaseUrl: string; latestBaseUrl: string }) => Promise<void>,
) {
  const app = express();
  app.use(express.json({ strict: false }));
  app.use('/api/workflows', workflowRoutes.workflowsRouter);
  app.use('/workflows', workflowRoutes.publishedWorkflowsRouter);
  app.use('/workflows-latest', workflowRoutes.latestWorkflowsRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve test server address');
  }

  try {
    const port = address.port;
    await run({
      apiBaseUrl: `http://127.0.0.1:${port}/api/workflows`,
      publishedBaseUrl: `http://127.0.0.1:${port}/workflows`,
      latestBaseUrl: `http://127.0.0.1:${port}/workflows-latest`,
    });
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

async function waitForRecordingWorkflows(
  apiBaseUrl: string,
  predicate: (workflows: Array<{ workflowId: string; totalRuns: number }>) => boolean,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await readJson<{
      workflows: Array<{ workflowId: string; totalRuns: number }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows`));

    if (predicate(response.workflows)) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Timed out waiting for workflow recordings');
}

async function waitForWorkflowRecordingRunCount(
  root: string,
  workflowId: string,
  expectedTotalRuns: number,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await workflowRecordings.listWorkflowRecordingRunsPage(root, workflowId, 1, 100, 'all');
    if (response.totalRuns === expectedTotalRuns) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for workflow ${workflowId} to reach ${expectedTotalRuns} recording runs`);
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

test('published workflow keeps referenced projects resolvable after the referenced project is moved', async () => {
  const referenced = await workflowMutations.createWorkflowProjectItem('', 'Referenced');
  const main = await workflowMutations.createWorkflowProjectItem('', 'Main');
  const passthroughProject = await fs.readFile(
    new URL('../../../../rivet/packages/node/test/test-graphs.rivet-project', import.meta.url),
    'utf8',
  );
  const referencedProjectId = 'refProject123';
  const referencedGraphId = 'refGraph123';
  const mainProjectId = 'mainProject123';
  const mainGraphId = 'mainGraph123';

  const createAnyPassthroughProject = (projectId: string, graphId: string, title: string) =>
    passthroughProject
      .replace('    title: Untitled Project', [
        `    title: ${title}`,
        `    mainGraphId: ${graphId}`,
      ].join('\n'))
      .replaceAll('ytCHmBvDFSkCnQ9L7DJLB', projectId)
      .replaceAll('kqaNrBo0WpJ1EOc2hj0zK', graphId)
      .replaceAll('dataType: string', 'dataType: any');

  const referencedContents = createAnyPassthroughProject(referencedProjectId, referencedGraphId, 'Referenced');
  const mainContents = createAnyPassthroughProject(mainProjectId, mainGraphId, 'Main')
    .replace(
      [
        `        '[hHAeA3eIMmdfGFOYeool0]:passthrough "Passthrough"':`,
        '          outgoingConnections:',
        '            - output1->"Graph Output" Dp5_0MQuZk7_UTdBQGX-P/value',
        '          visualData: 928/554/205/9//',
      ].join('\n'),
      [
        `        '[hHAeA3eIMmdfGFOYeool0]:referencedGraphAlias "Referenced Passthrough"':`,
        '          data:',
        `            projectId: ${referencedProjectId}`,
        `            graphId: ${referencedGraphId}`,
        '            useErrorOutput: false',
        '          outgoingConnections:',
        '            - output->"Graph Output" Dp5_0MQuZk7_UTdBQGX-P/value',
        '          visualData: 928/554/205/9//',
      ].join('\n'),
    )
    .replace(
      '            - data->"Passthrough" hHAeA3eIMmdfGFOYeool0/input1',
      '            - data->"Referenced Passthrough" hHAeA3eIMmdfGFOYeool0/input',
    )
    .replace(
      '  references: []',
      [
        '  references:',
        `    - id: ${referencedProjectId}`,
        '      hintPaths:',
        '        - ./Referenced.rivet-project',
        '      title: Referenced',
      ].join('\n'),
    );

  await fs.writeFile(referenced.absolutePath, referencedContents, 'utf8');
  await fs.writeFile(main.absolutePath, mainContents, 'utf8');

  await workflowMutations.publishWorkflowProjectItem(referenced.relativePath, {
    endpointName: 'referenced-project-endpoint',
  });
  await workflowMutations.publishWorkflowProjectItem(main.relativePath, {
    endpointName: 'main-with-reference-endpoint',
  });

  await workflowMutations.createWorkflowFolderItem('Moved', '');
  await workflowQuery.moveWorkflowProject(workflowsRoot, referenced.relativePath, 'Moved');

  await withWorkflowExecutionServer(async ({ publishedBaseUrl }) => {
    const response = await fetch(`${publishedBaseUrl}/main-with-reference-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(response.ok, true);
    const body = await response.json() as { durationMs?: number };
    assert.equal(typeof body.durationMs, 'number');
  });
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

test('published and latest workflow execution create replayable recordings that are listed over HTTP', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Recorded');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'recorded-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl, latestBaseUrl }) => {
    const publishedResponse = await fetch(`${publishedBaseUrl}/recorded-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'published' }),
    });
    assert.equal(publishedResponse.ok, true);

    const latestResponse = await fetch(`${latestBaseUrl}/recorded-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'latest' }),
    });
    assert.equal(latestResponse.ok, true);

    const workflowsResponse = await waitForRecordingWorkflows(
      apiBaseUrl,
      (workflows) => workflows[0]?.totalRuns === 2,
    ) as {
      workflows: Array<{
        workflowId: string;
        project: { absolutePath: string; settings: { endpointName: string } };
        totalRuns: number;
      }>;
    };

    assert.equal(workflowsResponse.workflows.length, 1);
    assert.equal(workflowsResponse.workflows[0]?.project.absolutePath, created.absolutePath);
    assert.equal(workflowsResponse.workflows[0]?.project.settings.endpointName, 'recorded-endpoint');
    assert.equal(workflowsResponse.workflows[0]?.totalRuns, 2);

    const workflowId = workflowsResponse.workflows[0]!.workflowId;
    const runsResponse = await readJson<{
      totalRuns: number;
      runs: Array<{
        id: string;
        runKind: string;
        status: string;
      }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowId)}/runs?page=1&pageSize=20&status=all`));

    assert.equal(runsResponse.totalRuns, 2);
    assert.equal(runsResponse.runs.length, 2);
    assert.deepEqual(
      runsResponse.runs.map((recording) => recording.runKind).sort(),
      ['latest', 'published'],
    );
    assert.deepEqual(
      runsResponse.runs.map((recording) => recording.status),
      ['succeeded', 'succeeded'],
    );

    const sourceProject = await rivetNode.loadProjectFromFile(created.absolutePath);
    const recordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(workflowsRoot, sourceProject.metadata.id);

    for (const recording of runsResponse.runs) {
      const bundlePath = path.join(recordingsRoot, recording.id);
      const recordingPath = workflowFs.getWorkflowRecordingPath(bundlePath);
      const replayProjectPath = workflowFs.getWorkflowRecordingReplayProjectPath(bundlePath);

      assert.equal(await workflowFs.pathExists(recordingPath), true);
      assert.equal(await workflowFs.pathExists(replayProjectPath), true);

      const replayProject = rivetNode.loadProjectFromString(
        await workflowRecordings.readWorkflowRecordingArtifact(workflowsRoot, recording.id, 'replay-project'),
      );
      const serializedRecording = await workflowRecordings.readWorkflowRecordingArtifact(workflowsRoot, recording.id, 'recording');
      const recorder = rivetNode.ExecutionRecorder.deserializeFromString(serializedRecording);

      assert.notEqual(replayProject.metadata.id, sourceProject.metadata.id);
      assert.deepEqual(Object.keys(replayProject.graphs), Object.keys(sourceProject.graphs));
      assert.ok(recorder.events.length > 0);
    }
  });
});

test('published workflow responds with any outputs and records the run asynchronously', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'AnyResponse');
  const passthroughProject = await fs.readFile(
    new URL('../../../../rivet/packages/node/test/test-graphs.rivet-project', import.meta.url),
    'utf8',
  );

  await fs.writeFile(
    created.absolutePath,
    passthroughProject
      .replace('    title: Untitled Project', [
        '    title: Untitled Project',
        '    mainGraphId: kqaNrBo0WpJ1EOc2hj0zK',
      ].join('\n'))
      .replaceAll('dataType: string', 'dataType: any'),
    'utf8',
  );

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'any-response-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl }) => {
    const response = await fetch(`${publishedBaseUrl}/any-response-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(response.ok, true);

    const body = await response.json() as { foo: string; durationMs: number };
    assert.equal(body.foo, 'bar');
    assert.equal(typeof body.durationMs, 'number');

    const workflowsResponse = await waitForRecordingWorkflows(
      apiBaseUrl,
      (workflows) => workflows[0]?.totalRuns === 1,
    ) as {
      workflows: Array<{ totalRuns: number }>;
    };

    assert.equal(workflowsResponse.workflows.length, 1);
    assert.equal(workflowsResponse.workflows[0]?.totalRuns, 1);
  });
});

test('published workflow preserves falsy top-level JSON inputs and null any outputs', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'AnyFalsyResponse');
  const passthroughProject = await fs.readFile(
    new URL('../../../../rivet/packages/node/test/test-graphs.rivet-project', import.meta.url),
    'utf8',
  );

  await fs.writeFile(
    created.absolutePath,
    passthroughProject
      .replace('    title: Untitled Project', [
        '    title: Untitled Project',
        '    mainGraphId: kqaNrBo0WpJ1EOc2hj0zK',
      ].join('\n'))
      .replaceAll('dataType: string', 'dataType: any'),
    'utf8',
  );

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'any-falsy-response-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl }) => {
    const cases: Array<false | 0 | '' | null> = [false, 0, '', null];

    for (const value of cases) {
      const response = await fetch(`${publishedBaseUrl}/any-falsy-response-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
        signal: AbortSignal.timeout(5000),
      });

      assert.equal(response.ok, true);
      assert.ok(response.headers.get('x-duration-ms'));
      assert.deepEqual(await response.json(), value);
    }

    const workflowsResponse = await waitForRecordingWorkflows(
      apiBaseUrl,
      (workflows) => workflows[0]?.totalRuns === cases.length,
    ) as {
      workflows: Array<{ totalRuns: number }>;
    };

    assert.equal(workflowsResponse.workflows.length, 1);
    assert.equal(workflowsResponse.workflows[0]?.totalRuns, cases.length);
  });
});

test('recordings list keeps once-published workflows after unpublish', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'RecordedHistory');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'recorded-history-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl }) => {
    const publishedResponse = await fetch(`${publishedBaseUrl}/recorded-history-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'published' }),
    });
    assert.equal(publishedResponse.ok, true);

    await workflowMutations.unpublishWorkflowProjectItem(created.relativePath);

    const workflowsResponse = await readJson<{
      workflows: Array<{
        workflowId: string;
        project: { absolutePath: string; settings: { status: string; endpointName: string } };
        totalRuns: number;
      }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows`));

    assert.equal(workflowsResponse.workflows.length, 1);
    assert.equal(workflowsResponse.workflows[0]?.project.absolutePath, created.absolutePath);
    assert.equal(workflowsResponse.workflows[0]?.project.settings.status, 'unpublished');
    assert.equal(workflowsResponse.workflows[0]?.project.settings.endpointName, 'recorded-history-endpoint');
    assert.equal(workflowsResponse.workflows[0]?.totalRuns, 1);

    const runsResponse = await readJson<{
      runs: Array<{ runKind: string; status: string }>;
    }>(await fetch(
      `${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowsResponse.workflows[0]!.workflowId)}/runs?page=1&pageSize=20&status=all`,
    ));

    assert.equal(runsResponse.runs.length, 1);
    assert.equal(runsResponse.runs[0]?.runKind, 'published');
    assert.equal(runsResponse.runs[0]?.status, 'succeeded');
  });
});

test('workflow recording runs endpoint paginates and filters failed runs server-side', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Paged');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'paged-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl }) => {
    for (let index = 0; index < 3; index++) {
      const response = await fetch(`${publishedBaseUrl}/paged-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: index }),
      });
      assert.equal(response.ok, true);
    }

    const workflowsResponse = await waitForRecordingWorkflows(
      apiBaseUrl,
      (workflows) => workflows[0]?.totalRuns === 3,
    ) as {
      workflows: Array<{ workflowId: string }>;
    };
    const workflowId = workflowsResponse.workflows[0]!.workflowId;

    const pageOne = await readJson<{
      page: number;
      pageSize: number;
      totalRuns: number;
      runs: Array<{ id: string }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowId)}/runs?page=1&pageSize=2&status=all`));

    assert.equal(pageOne.page, 1);
    assert.equal(pageOne.pageSize, 2);
    assert.equal(pageOne.totalRuns, 3);
    assert.equal(pageOne.runs.length, 2);

    const failedOnly = await readJson<{
      totalRuns: number;
      runs: Array<{ status: string }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowId)}/runs?page=1&pageSize=20&status=failed`));

    assert.equal(failedOnly.totalRuns, 0);
    assert.equal(failedOnly.runs.length, 0);
  });
});

test('workflow recording classification marks control-flow-excluded outputs as suspicious', () => {
  assert.equal(
    workflowExecution.getWorkflowRecordingStatusFromOutputs({
      output: { type: 'control-flow-excluded', value: undefined },
    }),
    'suspicious',
  );
  assert.equal(
    workflowExecution.getWorkflowRecordingStatusFromOutputs({
      output: { type: 'string', value: 'ok' },
    }),
    'succeeded',
  );
});

test('workflow recording failed filter includes suspicious runs', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Suspicious');
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
  const workflowId = loadedProject.metadata.id!;

  await workflowRecordings.persistWorkflowExecutionRecording({
    root: workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'suspicious-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'suspicious-recording',
        events: [],
        startTs: 1,
        finishTs: 1,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'published',
    status: 'suspicious',
    durationMs: 1,
  });

  await workflowRecordings.persistWorkflowExecutionRecording({
    root: workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'suspicious-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'successful-recording',
        events: [],
        startTs: 2,
        finishTs: 2,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'published',
    status: 'succeeded',
    durationMs: 2,
  });

  const failedOnly = await workflowRecordings.listWorkflowRecordingRunsPage(
    workflowsRoot,
    workflowId,
    1,
    20,
    'failed',
  );
  const workflowsResponse = await workflowRecordings.listWorkflowRecordingWorkflows(workflowsRoot);

  assert.equal(failedOnly.totalRuns, 1);
  assert.deepEqual(
    failedOnly.runs.map((run) => run.status),
    ['suspicious'],
  );
  assert.equal(workflowsResponse.workflows[0]?.failedRuns, 0);
});

test('workflow recording persistence snapshots the executed in-memory project state', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Stable');
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
  const mutatedContents = (await fs.readFile(created.absolutePath, 'utf8')).replace('Stable', 'Mutated');

  await fs.writeFile(created.absolutePath, mutatedContents, 'utf8');

  await workflowRecordings.persistWorkflowExecutionRecording({
    root: workflowsRoot,
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'stable-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'recording-id',
        events: [],
        startTs: 0,
        finishTs: 0,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'latest',
    status: 'succeeded',
    durationMs: 1,
  });

  const recordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(workflowsRoot, loadedProject.metadata.id);
  const bundles = await fs.readdir(recordingsRoot);
  assert.equal(bundles.length, 1);

  const replayProject = rivetNode.loadProjectFromString(
    await workflowRecordings.readWorkflowRecordingArtifact(workflowsRoot, bundles[0]!, 'replay-project'),
  );
  const mutatedProject = await rivetNode.loadProjectFromFile(created.absolutePath);

  assert.equal(replayProject.metadata.title, 'Stable');
  assert.equal(mutatedProject.metadata.title, 'Mutated');
});

test('workflow recording cleanup keeps only the newest configured runs per endpoint', async () => {
  const previousMaxRunsPerEndpoint = process.env.RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT;
  process.env.RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT = '2';

  try {
    const created = await workflowMutations.createWorkflowProjectItem('', 'EndpointLimited');
    const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
    const workflowId = loadedProject.metadata.id!;

    for (const index of [1, 2, 3]) {
      await workflowRecordings.persistWorkflowExecutionRecording({
        root: workflowsRoot,
        sourceProject: loadedProject,
        sourceProjectPath: created.absolutePath,
        executedProject: loadedProject,
        executedAttachedData: attachedData,
        executedDatasets: [],
        endpointName: 'endpoint-limited',
        recordingSerialized: JSON.stringify({
          version: 1,
          recording: {
            recordingId: `recording-${index}`,
            events: [],
            startTs: index,
            finishTs: index,
          },
          assets: {},
          strings: {},
        }),
        runKind: 'published',
        status: 'succeeded',
        durationMs: index,
      });
    }

    const runsPage = await waitForWorkflowRecordingRunCount(workflowsRoot, workflowId, 2);

    assert.equal(runsPage.runs.length, 2);
    assert.deepEqual(
      runsPage.runs.map((run) => run.durationMs),
      [3, 2],
    );

    const recordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(workflowsRoot, workflowId);
    const bundles = (await fs.readdir(recordingsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    assert.equal(bundles.length, 2);
  } finally {
    if (previousMaxRunsPerEndpoint == null) {
      delete process.env.RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT;
    } else {
      process.env.RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT = previousMaxRunsPerEndpoint;
    }
  }
});
