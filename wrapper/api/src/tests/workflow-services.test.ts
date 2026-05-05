import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { listenTestServer } from './helpers/http-server-harness.js';
import { createWorkflowTestRoots, resetWorkflowTestRoots } from './helpers/workflow-fixtures.js';

const { workflowsRoot, recordingsRoot, appDataRoot } = await createWorkflowTestRoots('rivet-workflows-');
process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = recordingsRoot;
process.env.RIVET_APP_DATA_ROOT = appDataRoot;

const workflowMutations = await import('../routes/workflows/workflow-mutations.js');
const workflowQuery = await import('../routes/workflows/workflow-query.js');
const workflowFs = await import('../routes/workflows/fs-helpers.js');
const workflowDownload = await import('../routes/workflows/workflow-download.js');
const workflowPublication = await import('../routes/workflows/publication.js');
const workflowRecordings = await import('../routes/workflows/recordings.js');
const workflowExecution = await import('../routes/workflows/execution.js');
const workflowRoutes = await import('../routes/workflows/index.js');
const workflowStorageBackend = await import('../routes/workflows/storage-backend.js');
const filesystemExecutionCache = await import('../routes/workflows/filesystem-execution-cache.js');
const rivetNode = await import('@valerypopoff/rivet2-node');

async function resetWorkflowsRoot() {
  filesystemExecutionCache.resetFilesystemExecutionCacheForTests();
  await workflowRecordings.resetWorkflowRecordingStorageForTests();
  await resetWorkflowTestRoots({ workflowsRoot, recordingsRoot, appDataRoot });
}

async function withEnvOverride(
  name: string,
  value: string | undefined,
  run: () => Promise<void>,
) {
  const previousValue = process.env[name];

  if (value == null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    await run();
  } finally {
    if (previousValue == null) {
      delete process.env[name];
    } else {
      process.env[name] = previousValue;
    }
  }
}

test.beforeEach(async () => {
  await resetWorkflowsRoot();
  await workflowFs.ensureWorkflowsRoot();
});

async function withWorkflowApiServer(run: (baseUrl: string) => Promise<void>) {
  await workflowStorageBackend.initializeWorkflowStorage();

  const app = express();
  app.use(express.json({ strict: false }));
  app.use('/workflows', workflowRoutes.workflowsRouter);
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((err as { status?: number }).status ?? 500).json({ error: err.message });
  });

  const server = http.createServer(app);
  const listener = await listenTestServer(server);

  try {
    await run(`${listener.baseUrl}/workflows`);
  } finally {
    await listener.close();
  }
}

async function withWorkflowExecutionServer(
  run: (urls: { apiBaseUrl: string; publishedBaseUrl: string; latestBaseUrl: string }) => Promise<void>,
) {
  await workflowStorageBackend.initializeWorkflowStorage();

  const app = express();
  app.use(express.json({ strict: false }));
  app.use('/api/workflows', workflowRoutes.workflowsRouter);
  app.use('/workflows', workflowRoutes.publishedWorkflowsRouter);
  app.use('/workflows-latest', workflowRoutes.latestWorkflowsRouter);
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((err as { status?: number }).status ?? 500).json({ error: err.message });
  });

  const server = http.createServer(app);
  const listener = await listenTestServer(server);

  try {
    await run({
      apiBaseUrl: `${listener.baseUrl}/api/workflows`,
      publishedBaseUrl: `${listener.baseUrl}/workflows`,
      latestBaseUrl: `${listener.baseUrl}/workflows-latest`,
    });
  } finally {
    await listener.close();
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

async function writeHeadersContextEchoProject(projectPath: string, projectName: string): Promise<void> {
  const project = rivetNode.loadProjectFromString(workflowFs.createBlankProjectFile(projectName));
  const graph = project.graphs[project.metadata.mainGraphId!];

  graph.nodes = [
    {
      type: 'context',
      title: 'Context',
      id: 'context-headers',
      visualData: { x: 0, y: 0, width: 300 },
      data: {
        id: 'headers',
        dataType: 'any',
        defaultValue: undefined,
        useDefaultValueInput: false,
      },
    } as never,
    {
      type: 'graphOutput',
      title: 'Graph Output',
      id: 'graph-output',
      visualData: { x: 360, y: 0, width: 300 },
      data: {
        id: 'output',
        dataType: 'any',
      },
    } as never,
  ];
  graph.connections = [
    {
      outputNodeId: 'context-headers',
      outputId: 'data',
      inputNodeId: 'graph-output',
      inputId: 'value',
    } as never,
  ];

  const serializedProject = rivetNode.serializeProject(project);
  if (typeof serializedProject !== 'string') {
    throw new TypeError('Expected serialized project to be a string');
  }
  await fs.writeFile(projectPath, serializedProject, 'utf8');
}

test('workflow request headers context is normalized to a safe string object', () => {
  const rawHeaders: Record<string, unknown> = Object.create(null);
  rawHeaders[' Content-Type '] = 'application/json';
  rawHeaders['X-Storyteller-Header'] = 'published-request-header';
  rawHeaders['x-forwarded-for'] = ['10.0.0.1', '10.0.0.2'];
  rawHeaders['x-broken-array'] = ['dropped', 123, undefined, 'also-dropped'];
  rawHeaders['x-empty-array'] = [];
  rawHeaders['x-undefined'] = undefined;
  rawHeaders['bad header'] = 'bad-name';
  rawHeaders['__proto__'] = 'polluted';
  rawHeaders['constructor'] = 'polluted';
  rawHeaders['prototype'] = 'polluted';

  const headers = workflowExecution.normalizeWorkflowRequestHeadersForContext(rawHeaders);

  assert.deepEqual(headers, {
    'content-type': 'application/json',
    'x-storyteller-header': 'published-request-header',
    'x-forwarded-for': '10.0.0.1, 10.0.0.2',
  });
  assert.equal(Object.getPrototypeOf(headers), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(headers, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(headers, 'constructor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(headers, 'prototype'), false);
  assert.ok(Object.values(headers).every((value) => typeof value === 'string'));
});

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

  assert.equal(renamedFolder.folder.name, 'folder');
  assert.equal(renamedFolder.folder.relativePath, 'folder');
  assert.deepEqual(renamedFolder.movedProjectPaths, []);
  assert.equal(await workflowFs.pathExists(path.join(workflowsRoot, 'folder')), true);
});

test('workflow folder rename reports moved project paths for nested projects', async () => {
  const createdFolder = await workflowMutations.createWorkflowFolderItem('Folder', '');
  const nestedFolder = await workflowMutations.createWorkflowFolderItem('Nested', createdFolder.relativePath);
  const rootProject = await workflowMutations.createWorkflowProjectItem(createdFolder.relativePath, 'Root Project');
  const nestedProject = await workflowMutations.createWorkflowProjectItem(nestedFolder.relativePath, 'Nested Project');

  const renamedFolder = await workflowMutations.renameWorkflowFolderItem(createdFolder.relativePath, 'Renamed Folder');

  assert.equal(renamedFolder.folder.relativePath, 'Renamed Folder');
  assert.deepEqual(renamedFolder.movedProjectPaths, [
    {
      fromAbsolutePath: rootProject.absolutePath,
      toAbsolutePath: path.join(workflowsRoot, 'Renamed Folder', 'Root Project.rivet-project'),
    },
    {
      fromAbsolutePath: nestedProject.absolutePath,
      toAbsolutePath: path.join(workflowsRoot, 'Renamed Folder', 'Nested', 'Nested Project.rivet-project'),
    },
  ]);
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

test('workflow tree route disables caching', async () => {
  await workflowMutations.createWorkflowProjectItem('', 'CacheHeaders');

  await withWorkflowApiServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/tree`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
    assert.equal(response.headers.get('pragma'), 'no-cache');
  });
});

test('workflow project duplication creates an unpublished copy in the same folder', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Example');

  const duplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);

  assert.equal(duplicate.relativePath, 'Example [unpublished] Copy.rivet-project');
  assert.equal(duplicate.name, 'Example [unpublished] Copy');
  assert.equal(duplicate.settings.status, 'unpublished');
  assert.equal(duplicate.settings.endpointName, '');
  assert.equal(await workflowFs.pathExists(duplicate.absolutePath), true);
});

test('workflow project duplication assigns a fresh project id and matching title', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Independent');

  const duplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);
  const originalProject = await rivetNode.loadProjectFromFile(created.absolutePath);
  const duplicateProject = await rivetNode.loadProjectFromFile(duplicate.absolutePath);

  assert.notEqual(duplicateProject.metadata.id, originalProject.metadata.id);
  assert.equal(duplicateProject.metadata.title, 'Independent [unpublished] Copy');
});

test('workflow project duplication does not copy dataset or settings sidecars', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Sidecars');
  const originalSidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);

  await fs.writeFile(originalSidecars.dataset, '{"rows":[]}', 'utf8');
  await fs.writeFile(originalSidecars.settings, '{"endpointName":"published-demo"}', 'utf8');

  const duplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);
  const duplicateSidecars = workflowFs.getProjectSidecarPaths(duplicate.absolutePath);

  assert.equal(await workflowFs.pathExists(originalSidecars.dataset), true);
  assert.equal(await workflowFs.pathExists(originalSidecars.settings), true);
  assert.equal(await workflowFs.pathExists(duplicateSidecars.dataset), false);
  assert.equal(await workflowFs.pathExists(duplicateSidecars.settings), false);
});

test('workflow project duplication resolves naming collisions with numbered copy suffixes', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Collision');

  const firstDuplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);
  const secondDuplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);
  const thirdDuplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);

  assert.equal(firstDuplicate.relativePath, 'Collision [unpublished] Copy.rivet-project');
  assert.equal(secondDuplicate.relativePath, 'Collision [unpublished] Copy 1.rivet-project');
  assert.equal(thirdDuplicate.relativePath, 'Collision [unpublished] Copy 2.rivet-project');
});

test('workflow project duplication stays literal when duplicating a duplicate', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Literal');
  const duplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);

  const duplicateOfDuplicate = await workflowMutations.duplicateWorkflowProjectItem(duplicate.relativePath);

  assert.equal(duplicate.relativePath, 'Literal [unpublished] Copy.rivet-project');
  assert.equal(duplicateOfDuplicate.relativePath, 'Literal [unpublished] Copy [unpublished] Copy.rivet-project');
});

test('workflow project duplication preserves literal user-authored names that already end with a copy-style suffix', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'LiteralSuffix');
  const renamed = await workflowMutations.renameWorkflowProjectItem(created.relativePath, 'LiteralSuffix [unpublished] Copy');

  const duplicate = await workflowMutations.duplicateWorkflowProjectItem(renamed.project.relativePath);

  assert.equal(
    duplicate.relativePath,
    'LiteralSuffix [unpublished] Copy [unpublished] Copy.rivet-project',
  );
});

test('workflow project duplication keeps published source state detached from the copy', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedSource');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'published-source-endpoint',
  });

  const duplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath);
  const duplicateSidecars = workflowFs.getProjectSidecarPaths(duplicate.absolutePath);

  assert.equal(duplicate.relativePath, 'PublishedSource [published] Copy.rivet-project');
  assert.equal(duplicate.settings.status, 'unpublished');
  assert.equal(duplicate.settings.endpointName, '');
  assert.equal(await workflowFs.pathExists(duplicateSidecars.settings), false);
  assert.equal(await workflowFs.pathExists(duplicateSidecars.dataset), false);
});

test('workflow project duplication can use the published snapshot when unpublished changes exist', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedVariant');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'published-variant-endpoint',
  });

  const liveContents = await fs.readFile(created.absolutePath, 'utf8');
  await fs.writeFile(
    created.absolutePath,
    liveContents.replace('        description: ""', '        description: "Live only"'),
    'utf8',
  );

  const publishedDuplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath, 'published');
  const liveDuplicate = await workflowMutations.duplicateWorkflowProjectItem(created.relativePath, 'live');
  const publishedDuplicateProject = await rivetNode.loadProjectFromFile(publishedDuplicate.absolutePath);
  const liveDuplicateProject = await rivetNode.loadProjectFromFile(liveDuplicate.absolutePath);
  const publishedGraph = Object.values(publishedDuplicateProject.graphs)[0];
  const liveGraph = Object.values(liveDuplicateProject.graphs)[0];

  assert.equal(publishedDuplicate.relativePath, 'PublishedVariant [published] Copy.rivet-project');
  assert.equal(liveDuplicate.relativePath, 'PublishedVariant [unpublished changes] Copy.rivet-project');
  assert.equal(publishedGraph?.metadata?.description ?? '', '');
  assert.equal(liveGraph?.metadata?.description ?? '', 'Live only');
});

test('workflow project upload imports a project into the selected folder with a fresh id', async () => {
  await workflowMutations.createWorkflowFolderItem('Uploads', '');
  const created = await workflowMutations.createWorkflowProjectItem('', 'Imported');
  const uploadedContents = await fs.readFile(created.absolutePath, 'utf8');
  const originalProject = rivetNode.loadProjectFromString(uploadedContents);

  const uploaded = await workflowMutations.uploadWorkflowProjectItem(
    'Uploads',
    'Imported.rivet-project',
    uploadedContents,
  );
  const uploadedProject = await rivetNode.loadProjectFromFile(uploaded.absolutePath);

  assert.equal(uploaded.relativePath, 'Uploads/Imported.rivet-project');
  assert.equal(uploaded.name, 'Imported');
  assert.equal(uploaded.settings.status, 'unpublished');
  assert.equal(uploaded.settings.endpointName, '');
  assert.notEqual(uploadedProject.metadata.id, originalProject.metadata.id);
  assert.equal(uploadedProject.metadata.title, 'Imported');
});

test('workflow project upload resolves naming collisions with numbered suffixes', async () => {
  await workflowMutations.createWorkflowFolderItem('Uploads', '');
  const created = await workflowMutations.createWorkflowProjectItem('', 'CollisionUpload');
  const uploadedContents = await fs.readFile(created.absolutePath, 'utf8');

  const firstUpload = await workflowMutations.uploadWorkflowProjectItem(
    'Uploads',
    'CollisionUpload.rivet-project',
    uploadedContents,
  );
  const secondUpload = await workflowMutations.uploadWorkflowProjectItem(
    'Uploads',
    'CollisionUpload.rivet-project',
    uploadedContents,
  );
  const secondUploadedProject = await rivetNode.loadProjectFromFile(secondUpload.absolutePath);

  assert.equal(firstUpload.relativePath, 'Uploads/CollisionUpload.rivet-project');
  assert.equal(secondUpload.relativePath, 'Uploads/CollisionUpload 1.rivet-project');
  assert.equal(secondUploadedProject.metadata.title, 'CollisionUpload 1');
});

test('workflow project upload keeps published source state detached from the imported copy', async () => {
  await workflowMutations.createWorkflowFolderItem('Uploads', '');
  const created = await workflowMutations.createWorkflowProjectItem('', 'UploadedPublishedSource');
  const originalSidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);

  await fs.writeFile(originalSidecars.dataset, '{"rows":[]}', 'utf8');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'uploaded-published-source-endpoint',
  });

  const uploaded = await workflowMutations.uploadWorkflowProjectItem(
    'Uploads',
    'UploadedPublishedSource.rivet-project',
    await fs.readFile(created.absolutePath, 'utf8'),
  );
  const uploadedSidecars = workflowFs.getProjectSidecarPaths(uploaded.absolutePath);

  assert.equal(uploaded.settings.status, 'unpublished');
  assert.equal(uploaded.settings.endpointName, '');
  assert.equal(await workflowFs.pathExists(uploadedSidecars.dataset), false);
  assert.equal(await workflowFs.pathExists(uploadedSidecars.settings), false);
});

test('workflow project upload rejects invalid project files', async () => {
  await workflowMutations.createWorkflowFolderItem('Uploads', '');

  await assert.rejects(
    workflowMutations.uploadWorkflowProjectItem('Uploads', 'Broken.rivet-project', 'not: valid: yaml: ['),
    /Could not upload project: invalid project file/,
  );
});

test('workflow project download reads the live unpublished file with an unpublished tag', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DownloadUnpublished');
  const liveContents = await fs.readFile(created.absolutePath, 'utf8');

  const download = await workflowDownload.readWorkflowProjectDownload(created.relativePath, 'live');

  assert.equal(download.contents, liveContents);
  assert.equal(download.fileName, 'DownloadUnpublished [unpublished].rivet-project');
});

test('workflow project download reads the published snapshot with a published tag', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DownloadPublished');
  const originalLiveContents = await fs.readFile(created.absolutePath, 'utf8');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'download-published-endpoint',
  });

  const download = await workflowDownload.readWorkflowProjectDownload(created.relativePath, 'published');

  assert.equal(download.contents, originalLiveContents);
  assert.equal(download.fileName, 'DownloadPublished [published].rivet-project');
});

test('workflow project download distinguishes live unpublished changes from the published version', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DownloadChanged');
  const originalLiveContents = await fs.readFile(created.absolutePath, 'utf8');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'download-changed-endpoint',
  });

  const changedLiveContents = originalLiveContents.replace('title: "DownloadChanged"', 'title: "DownloadChanged Live"');
  await fs.writeFile(created.absolutePath, changedLiveContents, 'utf8');

  const liveDownload = await workflowDownload.readWorkflowProjectDownload(created.relativePath, 'live');
  const publishedDownload = await workflowDownload.readWorkflowProjectDownload(created.relativePath, 'published');

  assert.equal(liveDownload.contents, changedLiveContents);
  assert.equal(liveDownload.fileName, 'DownloadChanged [unpublished changes].rivet-project');
  assert.equal(publishedDownload.contents, originalLiveContents);
  assert.equal(publishedDownload.fileName, 'DownloadChanged [published].rivet-project');
});

test('workflow project download rejects published downloads for unpublished projects', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'NoPublishedDownload');

  await assert.rejects(
    workflowDownload.readWorkflowProjectDownload(created.relativePath, 'published'),
    /Published version is not available for this project/,
  );
});

test('workflow project download returns not found for missing projects', async () => {
  await assert.rejects(
    workflowDownload.readWorkflowProjectDownload('Missing.rivet-project', 'live'),
    /Project not found/,
  );
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

test('workflow folder rename route reports moved project paths over HTTP', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdFolder = await readJson<{ folder: { relativePath: string } }>(await fetch(`${baseUrl}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Folder' }),
    }));

    const createdProject = await readJson<{ project: { absolutePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderRelativePath: createdFolder.folder.relativePath, name: 'Example' }),
    }));

    const renamedFolder = await readJson<{
      folder: { relativePath: string };
      movedProjectPaths: Array<{ fromAbsolutePath: string; toAbsolutePath: string }>;
    }>(await fetch(`${baseUrl}/folders`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: createdFolder.folder.relativePath,
        newName: 'Renamed Folder',
      }),
    }));

    assert.equal(renamedFolder.folder.relativePath, 'Renamed Folder');
    assert.deepEqual(renamedFolder.movedProjectPaths, [
      {
        fromAbsolutePath: createdProject.project.absolutePath,
        toAbsolutePath: path.join(workflowsRoot, 'Renamed Folder', 'Example.rivet-project'),
      },
    ]);
  });
});

test('workflow duplicate route creates a duplicate and exposes it through the tree', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HttpDuplicate' }),
    }));

    const duplicated = await readJson<{ project: { relativePath: string; settings: { status: string; endpointName: string } } }>(
      await fetch(`${baseUrl}/projects/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: createdProject.project.relativePath }),
      }),
    );

    assert.equal(duplicated.project.relativePath, 'HttpDuplicate [unpublished] Copy.rivet-project');
    assert.equal(duplicated.project.settings.status, 'unpublished');
    assert.equal(duplicated.project.settings.endpointName, '');

    const tree = await readJson<{ projects: Array<{ relativePath: string }> }>(await fetch(`${baseUrl}/tree`));
    assert.deepEqual(
      tree.projects.map((project) => project.relativePath),
      ['HttpDuplicate [unpublished] Copy.rivet-project', 'HttpDuplicate.rivet-project'],
    );
  });
});

test('workflow duplicate route can duplicate the published snapshot for projects with unpublished changes', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string; absolutePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HttpDuplicatePublished' }),
    }));

    await readJson<{ project: { settings: { status: string } } }>(await fetch(`${baseUrl}/projects/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: createdProject.project.relativePath,
        settings: { endpointName: 'http-duplicate-published-endpoint' },
      }),
    }));

    const liveContents = await fs.readFile(createdProject.project.absolutePath, 'utf8');
    await fs.writeFile(
      createdProject.project.absolutePath,
      liveContents.replace('        description: ""', '        description: "Changed after publish"'),
      'utf8',
    );

    const duplicated = await readJson<{ project: { absolutePath: string; relativePath: string } }>(
      await fetch(`${baseUrl}/projects/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: createdProject.project.relativePath, version: 'published' }),
      }),
    );
    const duplicatedProject = await rivetNode.loadProjectFromFile(duplicated.project.absolutePath);
    const duplicatedGraph = Object.values(duplicatedProject.graphs)[0];

    assert.equal(duplicated.project.relativePath, 'HttpDuplicatePublished [published] Copy.rivet-project');
    assert.equal(duplicatedGraph?.metadata?.description ?? '', '');
  });
});

test('workflow duplicate route returns a controlled 400 for invalid project files', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string; absolutePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'BrokenDuplicate' }),
    }));

    await fs.writeFile(createdProject.project.absolutePath, 'not: valid: yaml: [', 'utf8');

    const response = await fetch(`${baseUrl}/projects/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdProject.project.relativePath }),
    });

    const body = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Could not duplicate project: invalid project file');
  });
});

test('workflow duplicate route rejects published duplication when no published version exists', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NoPublishedDuplicate' }),
    }));

    const response = await fetch(`${baseUrl}/projects/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdProject.project.relativePath, version: 'published' }),
    });
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 409);
    assert.equal(body.error, 'Published version is not available for this project');
  });
});

test('workflow upload route imports projects into folders and numbers collisions', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdFolder = await readJson<{ folder: { relativePath: string } }>(await fetch(`${baseUrl}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Uploads' }),
    }));
    const sourceProject = await workflowMutations.createWorkflowProjectItem('', 'HttpUpload');
    const sourceContents = await fs.readFile(sourceProject.absolutePath, 'utf8');

    const firstUpload = await readJson<{ project: { relativePath: string; settings: { status: string; endpointName: string } } }>(
      await fetch(`${baseUrl}/projects/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderRelativePath: createdFolder.folder.relativePath,
          fileName: 'HttpUpload.rivet-project',
          contents: sourceContents,
        }),
      }),
    );
    const secondUpload = await readJson<{ project: { relativePath: string } }>(
      await fetch(`${baseUrl}/projects/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderRelativePath: createdFolder.folder.relativePath,
          fileName: 'HttpUpload.rivet-project',
          contents: sourceContents,
        }),
      }),
    );

    assert.equal(firstUpload.project.relativePath, 'Uploads/HttpUpload.rivet-project');
    assert.equal(firstUpload.project.settings.status, 'unpublished');
    assert.equal(firstUpload.project.settings.endpointName, '');
    assert.equal(secondUpload.project.relativePath, 'Uploads/HttpUpload 1.rivet-project');

    const tree = await readJson<{ folders: Array<{ relativePath: string; projects: Array<{ relativePath: string }> }> }>(
      await fetch(`${baseUrl}/tree`),
    );
    const uploadsFolder = tree.folders.find((folder) => folder.relativePath === 'Uploads');

    assert.deepEqual(
      uploadsFolder?.projects.map((project) => project.relativePath),
      ['Uploads/HttpUpload 1.rivet-project', 'Uploads/HttpUpload.rivet-project'],
    );
  });
});

test('workflow upload route validates request shape and missing folders cleanly', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const invalidResponse = await fetch(`${baseUrl}/projects/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderRelativePath: '', fileName: 'Broken.txt', contents: 'hello' }),
    });
    const invalidBody = await invalidResponse.json() as { error?: string };

    assert.equal(invalidResponse.status, 400);
    assert.equal(invalidBody.error, 'Expected .rivet-project file');

    const missingFolderResponse = await fetch(`${baseUrl}/projects/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderRelativePath: 'MissingFolder',
        fileName: 'Uploaded.rivet-project',
        contents: await fs.readFile((await workflowMutations.createWorkflowProjectItem('', 'UploadedSource')).absolutePath, 'utf8'),
      }),
    });
    const missingFolderBody = await missingFolderResponse.json() as { error?: string };

    assert.equal(missingFolderResponse.status, 404);
    assert.equal(missingFolderBody.error, 'Folder not found');
  });
});

test('workflow download route streams unpublished projects with attachment headers', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string; absolutePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HttpDownloadUnpublished' }),
    }));
    const expectedContents = await fs.readFile(createdProject.project.absolutePath, 'utf8');

    const response = await fetch(`${baseUrl}/projects/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdProject.project.relativePath, version: 'live' }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/x-yaml/);
    assert.match(
      response.headers.get('content-disposition') ?? '',
      /filename="HttpDownloadUnpublished \[unpublished\]\.rivet-project"/,
    );
    assert.equal(await response.text(), expectedContents);
  });
});

test('workflow download route streams published and unpublished-changes variants separately', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string; absolutePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HttpDownloadChanged' }),
    }));
    const originalContents = await fs.readFile(createdProject.project.absolutePath, 'utf8');

    await readJson<{ project: { settings: { status: string } } }>(await fetch(`${baseUrl}/projects/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: createdProject.project.relativePath,
        settings: { endpointName: 'http-download-changed-endpoint' },
      }),
    }));

    const changedContents = originalContents.replace('title: "HttpDownloadChanged"', 'title: "HttpDownloadChanged Live"');
    await fs.writeFile(createdProject.project.absolutePath, changedContents, 'utf8');

    const publishedResponse = await fetch(`${baseUrl}/projects/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdProject.project.relativePath, version: 'published' }),
    });
    const liveResponse = await fetch(`${baseUrl}/projects/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdProject.project.relativePath, version: 'live' }),
    });

    assert.equal(publishedResponse.status, 200);
    assert.equal(liveResponse.status, 200);
    assert.match(
      publishedResponse.headers.get('content-disposition') ?? '',
      /filename="HttpDownloadChanged \[published\]\.rivet-project"/,
    );
    assert.match(
      liveResponse.headers.get('content-disposition') ?? '',
      /filename="HttpDownloadChanged \[unpublished changes\]\.rivet-project"/,
    );
    assert.equal(await publishedResponse.text(), originalContents);
    assert.equal(await liveResponse.text(), changedContents);
  });
});

test('workflow download route validates request shape and reports missing or unpublished sources cleanly', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const invalidResponse = await fetch(`${baseUrl}/projects/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: 'Anything.rivet-project', version: 'invalid' }),
    });
    const invalidBody = await invalidResponse.json() as { error?: string };

    assert.equal(invalidResponse.status, 400);
    assert.ok(invalidBody.error);

    const missingResponse = await fetch(`${baseUrl}/projects/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: 'Missing.rivet-project', version: 'live' }),
    });
    const missingBody = await missingResponse.json() as { error?: string };

    assert.equal(missingResponse.status, 404);
    assert.equal(missingBody.error, 'Project not found');

    const createdProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HttpDownloadUnavailable' }),
    }));

    const unavailableResponse = await fetch(`${baseUrl}/projects/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: createdProject.project.relativePath, version: 'published' }),
    });
    const unavailableBody = await unavailableResponse.json() as { error?: string };

    assert.equal(unavailableResponse.status, 409);
    assert.equal(unavailableBody.error, 'Published version is not available for this project');
  });
});

test('publish and unpublish keep workflow project behavior stable', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Published');

  const published = await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'demo-endpoint',
  });

  assert.equal(published.settings.status, 'published');
  assert.equal(published.settings.endpointName, 'demo-endpoint');
  assert.match(published.settings.lastPublishedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(await workflowFs.pathExists(path.join(workflowsRoot, '.published')), true);

  const unpublished = await workflowMutations.unpublishWorkflowProjectItem(created.relativePath);
  assert.equal(unpublished.settings.status, 'unpublished');
  assert.equal(unpublished.settings.endpointName, 'demo-endpoint');
  assert.equal(unpublished.settings.lastPublishedAt, published.settings.lastPublishedAt);
  assert.equal(await workflowPublication.findPublishedWorkflowByEndpoint(workflowsRoot, 'demo-endpoint'), null);
  assert.equal(await workflowPublication.findLatestWorkflowByEndpoint(workflowsRoot, 'demo-endpoint'), null);
});

test('workflow publish and unpublish routes preserve publication state over HTTP', async () => {
  await withWorkflowApiServer(async (baseUrl) => {
    const createdProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Published' }),
    }));

    const published = await readJson<{ project: { settings: { status: string; endpointName: string; lastPublishedAt: string | null } } }>(
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
    assert.match(published.project.settings.lastPublishedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

    const unpublished = await readJson<{ project: { settings: { status: string; endpointName: string; lastPublishedAt: string | null } } }>(
      await fetch(`${baseUrl}/projects/unpublish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: createdProject.project.relativePath }),
      }),
    );

    assert.equal(unpublished.project.settings.status, 'unpublished');
    assert.equal(unpublished.project.settings.endpointName, 'http-endpoint');
    assert.equal(unpublished.project.settings.lastPublishedAt, published.project.settings.lastPublishedAt);
  });
});

test('full unpublish closes both published and latest execution routes while keeping the saved draft endpoint', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'ClosedExecution');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'closed-execution-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl, latestBaseUrl }) => {
    const publishedBefore = await fetch(`${publishedBaseUrl}/closed-execution-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'published-before-unpublish' }),
    });
    const latestBefore = await fetch(`${latestBaseUrl}/closed-execution-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'latest-before-unpublish' }),
    });

    assert.equal(publishedBefore.ok, true);
    assert.equal(latestBefore.ok, true);

    const unpublished = await readJson<{
      project: {
        settings: {
          status: string;
          endpointName: string;
        };
      };
    }>(await fetch(`${apiBaseUrl}/projects/unpublish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: created.relativePath }),
    }));

    assert.equal(unpublished.project.settings.status, 'unpublished');
    assert.equal(unpublished.project.settings.endpointName, 'closed-execution-endpoint');

    const publishedAfter = await fetch(`${publishedBaseUrl}/closed-execution-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'published-after-unpublish' }),
    });
    const latestAfter = await fetch(`${latestBaseUrl}/closed-execution-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'latest-after-unpublish' }),
    });

    assert.equal(publishedAfter.status, 404);
    assert.equal((await publishedAfter.json() as { error: string }).error, 'Published workflow not found');
    assert.equal(latestAfter.status, 404);
    assert.equal((await latestAfter.json() as { error: string }).error, 'Latest workflow not found');
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

test('filesystem save keeps published status on a no-op save and marks real changes as unpublished_changes', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'FilesystemSaveStatus');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'filesystem-save-status-endpoint',
  });

  const loaded = await workflowStorageBackend.loadHostedProject(created.absolutePath);
  await workflowStorageBackend.saveHostedProject({
    projectPath: created.absolutePath,
    contents: loaded.contents,
    datasetsContents: loaded.datasetsContents,
  });

  const afterNoOpSave = await workflowQuery.getWorkflowProject(workflowsRoot, created.absolutePath);
  assert.equal(afterNoOpSave.settings.status, 'published');

  await workflowStorageBackend.saveHostedProject({
    projectPath: created.absolutePath,
    contents: `${loaded.contents}\n# changed\n`,
    datasetsContents: loaded.datasetsContents,
  });

  const afterRealSave = await workflowQuery.getWorkflowProject(workflowsRoot, created.absolutePath);
  assert.equal(afterRealSave.settings.status, 'unpublished_changes');
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
  assert.match(currentSettings.lastPublishedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

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

test('published workflow lookup skips stale endpoint matches and continues to a valid published project', async () => {
  const staleCandidate = await workflowMutations.createWorkflowProjectItem('', 'EndpointStaleCandidate');
  await workflowMutations.createWorkflowFolderItem('Nested', '');
  const healthyCandidate = await workflowMutations.createWorkflowProjectItem('Nested', 'EndpointHealthyCandidate');
  const sharedEndpoint = 'shared-published-endpoint';

  await workflowMutations.publishWorkflowProjectItem(healthyCandidate.relativePath, {
    endpointName: sharedEndpoint,
  });

  const staleSettingsPath = workflowFs.getProjectSidecarPaths(staleCandidate.absolutePath).settings;
  await fs.writeFile(staleSettingsPath, `${JSON.stringify({
    endpointName: sharedEndpoint,
    publishedEndpointName: sharedEndpoint,
    publishedSnapshotId: null,
    publishedStateHash: 'stale-publication-state',
    lastPublishedAt: '2025-01-01T00:00:00.000Z',
  }, null, 2)}\n`, 'utf8');

  const publishedMatch = await workflowPublication.findPublishedWorkflowByEndpoint(workflowsRoot, sharedEndpoint);

  assert.ok(publishedMatch);
  assert.equal(publishedMatch.projectPath, healthyCandidate.absolutePath);
  assert.match(publishedMatch.publishedProjectPath, /\.published[\\/].+\.rivet-project$/);
});

test('legacy published settings without lastPublishedAt still expose a fallback timestamp', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'LegacyPublished');
  const published = await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'legacy-published-endpoint',
  });
  const sidecars = workflowFs.getProjectSidecarPaths(created.absolutePath);
  const storedSettings = JSON.parse(await fs.readFile(sidecars.settings, 'utf8')) as Record<string, unknown>;

  delete storedSettings.lastPublishedAt;
  await fs.writeFile(sidecars.settings, `${JSON.stringify(storedSettings, null, 2)}\n`, 'utf8');

  const fallbackSettings = await workflowPublication.getWorkflowProjectSettings(created.absolutePath, created.name);

  assert.equal(fallbackSettings.status, published.settings.status);
  assert.equal(fallbackSettings.endpointName, published.settings.endpointName);
  assert.match(fallbackSettings.lastPublishedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
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
    const recordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(workflowFs.getWorkflowRecordingsRoot(workflowsRoot), sourceProject.metadata.id);

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

test('filesystem execution emits per-stage debug headers only when explicitly enabled', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Measured');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'measured-endpoint',
  });

  await withWorkflowExecutionServer(async ({ publishedBaseUrl, latestBaseUrl }) => {
    const debugDisabledResponse = await fetch(`${publishedBaseUrl}/measured-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'off' }),
    });

    assert.equal(debugDisabledResponse.ok, true);
    assert.equal(debugDisabledResponse.headers.get('x-workflow-resolve-ms'), null);
    assert.equal(debugDisabledResponse.headers.get('x-workflow-materialize-ms'), null);
    assert.equal(debugDisabledResponse.headers.get('x-workflow-execute-ms'), null);
    assert.equal(debugDisabledResponse.headers.get('x-workflow-cache'), null);

    await withEnvOverride('RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS', 'true', async () => {
      const publishedResponse = await fetch(`${publishedBaseUrl}/measured-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'published' }),
      });
      assert.equal(publishedResponse.ok, true);
      assert.match(publishedResponse.headers.get('x-workflow-resolve-ms') ?? '', /^\d+$/);
      assert.match(publishedResponse.headers.get('x-workflow-materialize-ms') ?? '', /^\d+$/);
      assert.match(publishedResponse.headers.get('x-workflow-execute-ms') ?? '', /^\d+$/);
      assert.equal(publishedResponse.headers.get('x-workflow-cache'), 'hit');

      const latestResponse = await fetch(`${latestBaseUrl}/measured-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'latest' }),
      });
      assert.equal(latestResponse.ok, true);
      assert.match(latestResponse.headers.get('x-workflow-resolve-ms') ?? '', /^\d+$/);
      assert.match(latestResponse.headers.get('x-workflow-materialize-ms') ?? '', /^\d+$/);
      assert.match(latestResponse.headers.get('x-workflow-execute-ms') ?? '', /^\d+$/);
      assert.equal(latestResponse.headers.get('x-workflow-cache'), 'hit');
    });
  });
});

test('filesystem execution cache rebuilds lazily after project-affecting mutations', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'WarmFilesystemExecution');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'warm-filesystem-endpoint',
  });

  await withEnvOverride('RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS', 'true', async () => {
    await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl, latestBaseUrl }) => {
      const firstPublishedResponse = await fetch(`${publishedBaseUrl}/warm-filesystem-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'published-warm' }),
      });
      assert.equal(firstPublishedResponse.ok, true);
      assert.equal(firstPublishedResponse.headers.get('x-workflow-cache'), 'hit');

      const firstLatestResponse = await fetch(`${latestBaseUrl}/warm-filesystem-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'latest-warm' }),
      });
      assert.equal(firstLatestResponse.ok, true);
      assert.equal(firstLatestResponse.headers.get('x-workflow-cache'), 'hit');

      const createdProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${apiBaseUrl}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Filesystem Mutation One' }),
      }));
      assert.equal(typeof createdProject.project.relativePath, 'string');

      const publishedMissResponse = await fetch(`${publishedBaseUrl}/warm-filesystem-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'published-miss' }),
      });
      assert.equal(publishedMissResponse.ok, true);
      assert.equal(publishedMissResponse.headers.get('x-workflow-cache'), 'miss');

      const publishedHitResponse = await fetch(`${publishedBaseUrl}/warm-filesystem-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'published-hit' }),
      });
      assert.equal(publishedHitResponse.ok, true);
      assert.equal(publishedHitResponse.headers.get('x-workflow-cache'), 'hit');

      const uploadedProject = await readJson<{ project: { relativePath: string } }>(await fetch(`${apiBaseUrl}/projects/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderRelativePath: '',
          fileName: 'filesystem-mutation-two.rivet-project',
          contents: await fs.readFile(created.absolutePath, 'utf8'),
        }),
      }));
      assert.equal(typeof uploadedProject.project.relativePath, 'string');

      const latestMissResponse = await fetch(`${latestBaseUrl}/warm-filesystem-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'latest-miss' }),
      });
      assert.equal(latestMissResponse.ok, true);
      assert.equal(latestMissResponse.headers.get('x-workflow-cache'), 'miss');

      const latestHitResponse = await fetch(`${latestBaseUrl}/warm-filesystem-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'latest-hit' }),
      });
      assert.equal(latestHitResponse.ok, true);
      assert.equal(latestHitResponse.headers.get('x-workflow-cache'), 'hit');
    });
  });
});

test('filesystem saveHostedProject refreshes latest materialization without dirtying the endpoint index', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'LatestSaveRefresh');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'latest-save-refresh-endpoint',
  });

  await withEnvOverride('RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS', 'true', async () => {
    await workflowStorageBackend.initializeWorkflowStorage();

    const beforeProject = await workflowStorageBackend.resolveLatestExecutionProject('latest-save-refresh-endpoint');
    assert.ok(beforeProject);
    assert.equal(beforeProject.debug?.cacheStatus, 'hit');
    assert.equal(beforeProject.project.metadata.title, 'LatestSaveRefresh');

    const loaded = await workflowStorageBackend.loadHostedProject(created.absolutePath);
    await workflowStorageBackend.saveHostedProject({
      projectPath: created.absolutePath,
      contents: loaded.contents.replace('title: "LatestSaveRefresh"', 'title: "LatestSaveRefresh Updated"'),
      datasetsContents: loaded.datasetsContents,
    });

    const afterProject = await workflowStorageBackend.resolveLatestExecutionProject('latest-save-refresh-endpoint');
    assert.ok(afterProject);
    assert.equal(afterProject.debug?.cacheStatus, 'hit');
    assert.equal(afterProject.project.metadata.title, 'LatestSaveRefresh Updated');

    const followupProject = await workflowStorageBackend.resolveLatestExecutionProject('latest-save-refresh-endpoint');
    assert.ok(followupProject);
    assert.equal(followupProject.debug?.cacheStatus, 'hit');
    assert.equal(followupProject.project.metadata.title, 'LatestSaveRefresh Updated');
  });
});

test('filesystem saveHostedProject exposes a permission error when the workflows root is not writable', async (t) => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PermissionSave');
  const loaded = await workflowStorageBackend.loadHostedProject(created.absolutePath);
  const originalWriteFile = fs.writeFile;

  t.mock.method(fs, 'writeFile', async (
    targetPath: Parameters<typeof fs.writeFile>[0],
    data: Parameters<typeof fs.writeFile>[1],
    options?: Parameters<typeof fs.writeFile>[2],
  ) => {
    if (String(targetPath) === created.absolutePath) {
      const error = new Error(`EACCES: permission denied, open '${created.absolutePath}'`) as Error & { code?: string };
      error.code = 'EACCES';
      throw error;
    }

    return originalWriteFile(targetPath, data, options as any);
  });

  await assert.rejects(
    workflowStorageBackend.saveHostedProject({
      projectPath: created.absolutePath,
      contents: loaded.contents.replace('title: "PermissionSave"', 'title: "PermissionSave Updated"'),
      datasetsContents: loaded.datasetsContents,
    }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 500);
      assert.equal((error as { expose?: boolean }).expose, true);
      assert.match(
        String((error as { message?: string }).message ?? ''),
        /Workflow storage is not writable/,
      );
      return true;
    },
  );
});

test('filesystem latest execution follows the draft endpoint after publish settings diverge', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DraftLatestBackend');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'draft-latest-backend-published',
  });

  await withEnvOverride('RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS', 'true', async () => {
    await workflowStorageBackend.initializeWorkflowStorage();

    const settingsPath = workflowFs.getWorkflowProjectSettingsPath(created.absolutePath);
    const settings = await workflowPublication.readStoredWorkflowProjectSettings(created.absolutePath, created.name);
    await fs.writeFile(
      settingsPath,
      `${JSON.stringify({
        ...settings,
        endpointName: 'draft-latest-backend-current',
      }, null, 2)}\n`,
      'utf8',
    );

    const latestProject = await workflowStorageBackend.resolveLatestExecutionProject('draft-latest-backend-current');
    assert.ok(latestProject);
    assert.equal(latestProject.projectVirtualPath, created.absolutePath);
    assert.equal(latestProject.debug?.cacheStatus, 'miss');

    const staleLatestProject = await workflowStorageBackend.resolveLatestExecutionProject('draft-latest-backend-published');
    assert.equal(staleLatestProject, null);

    const publishedProject = await workflowStorageBackend.resolvePublishedExecutionProject('draft-latest-backend-published');
    assert.ok(publishedProject);
    assert.equal(publishedProject.projectVirtualPath, created.absolutePath);
  });
});

test('filesystem published execution bypasses cold when a stale live-backed candidate becomes healthy', async () => {
  const staleCandidate = await workflowMutations.createWorkflowProjectItem('', 'ExecutionStaleCandidate');
  const staleOriginalContents = await fs.readFile(staleCandidate.absolutePath, 'utf8');
  const sharedEndpoint = 'execution-shared-published-endpoint';
  const publishedStateHash = await workflowPublication.createWorkflowPublicationStateHash(
    staleCandidate.absolutePath,
    sharedEndpoint,
  );

  await workflowMutations.createWorkflowFolderItem('Nested', '');
  const healthyCandidate = await workflowMutations.createWorkflowProjectItem('Nested', 'ExecutionHealthyCandidate');
  await workflowMutations.publishWorkflowProjectItem(healthyCandidate.relativePath, {
    endpointName: sharedEndpoint,
  });

  await fs.writeFile(staleCandidate.absolutePath, `${staleOriginalContents}\n# stale\n`, 'utf8');
  await fs.writeFile(
    workflowFs.getProjectSidecarPaths(staleCandidate.absolutePath).settings,
    `${JSON.stringify({
      endpointName: sharedEndpoint,
      publishedEndpointName: sharedEndpoint,
      publishedSnapshotId: null,
      publishedStateHash,
      lastPublishedAt: '2025-01-01T00:00:00.000Z',
    }, null, 2)}\n`,
    'utf8',
  );

  await withEnvOverride('RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS', 'true', async () => {
    await workflowStorageBackend.initializeWorkflowStorage();

    const initialProject = await workflowStorageBackend.resolvePublishedExecutionProject(sharedEndpoint);
    assert.ok(initialProject);
    assert.equal(initialProject.projectVirtualPath, healthyCandidate.absolutePath);
    assert.equal(initialProject.debug?.cacheStatus, 'hit');

    await fs.writeFile(staleCandidate.absolutePath, staleOriginalContents, 'utf8');

    const bypassProject = await workflowStorageBackend.resolvePublishedExecutionProject(sharedEndpoint);
    assert.ok(bypassProject);
    assert.equal(bypassProject.projectVirtualPath, staleCandidate.absolutePath);
    assert.equal(bypassProject.debug?.cacheStatus, 'bypass');

    const rebuiltProject = await workflowStorageBackend.resolvePublishedExecutionProject(sharedEndpoint);
    assert.ok(rebuiltProject);
    assert.equal(rebuiltProject.projectVirtualPath, staleCandidate.absolutePath);
    assert.equal(rebuiltProject.debug?.cacheStatus, 'miss');

    const warmProject = await workflowStorageBackend.resolvePublishedExecutionProject(sharedEndpoint);
    assert.ok(warmProject);
    assert.equal(warmProject.projectVirtualPath, staleCandidate.absolutePath);
    assert.equal(warmProject.debug?.cacheStatus, 'hit');
  });
});

test('filesystem execution helpers do not recreate the workflows root on the warm path', async (t) => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'WarmExecutionRoot');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'warm-execution-root-endpoint',
  });

  await workflowStorageBackend.initializeWorkflowStorage();

  const originalMkdir = fs.mkdir.bind(fs);
  const mkdirTargets: string[] = [];

  t.mock.method(fs, 'mkdir', async (dirPath: any, options?: any) => {
    mkdirTargets.push(String(dirPath));
    return originalMkdir(dirPath, options);
  });

  const publishedProject = await workflowStorageBackend.resolvePublishedExecutionProject('warm-execution-root-endpoint');
  assert.ok(publishedProject);
  assert.equal(publishedProject.debug?.cacheStatus, 'hit');

  const latestProject = await workflowStorageBackend.resolveLatestExecutionProject('warm-execution-root-endpoint');
  assert.ok(latestProject);
  assert.equal(latestProject.debug?.cacheStatus, 'hit');

  const referenceLoader = await workflowStorageBackend.createExecutionProjectReferenceLoader(created.absolutePath);
  assert.equal(typeof referenceLoader.loadProject, 'function');

  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
  await workflowStorageBackend.persistWorkflowExecutionRecordingWithBackend({
    sourceProject: loadedProject,
    sourceProjectPath: created.absolutePath,
    executedProject: loadedProject,
    executedAttachedData: attachedData,
    executedDatasets: [],
    endpointName: 'warm-execution-root-endpoint',
    recordingSerialized: JSON.stringify({
      version: 1,
      recording: {
        recordingId: 'warm-execution-root-recording',
        events: [],
        startTs: 1,
        finishTs: 1,
      },
      assets: {},
      strings: {},
    }),
    runKind: 'published',
    status: 'succeeded',
    durationMs: 1,
  });

  assert.deepEqual(
    mkdirTargets.filter((target) => target === workflowsRoot || target === workflowFs.getPublishedSnapshotsRoot(workflowsRoot)),
    [],
  );
});

test('filesystem execution resolution recreates a missing workflows root once and preserves not-found semantics', async () => {
  await workflowStorageBackend.initializeWorkflowStorage();

  await fs.rm(workflowsRoot, { recursive: true, force: true });
  filesystemExecutionCache.resetFilesystemExecutionCacheForTests();

  const publishedProject = await workflowStorageBackend.resolvePublishedExecutionProject('missing-endpoint');
  assert.equal(publishedProject, null);
  assert.equal(await workflowFs.pathExists(workflowsRoot), true);
  assert.equal(await workflowFs.pathExists(workflowFs.getPublishedSnapshotsRoot(workflowsRoot)), true);

  await fs.rm(workflowsRoot, { recursive: true, force: true });
  filesystemExecutionCache.resetFilesystemExecutionCacheForTests();

  const latestProject = await workflowStorageBackend.resolveLatestExecutionProject('missing-endpoint');
  assert.equal(latestProject, null);
  assert.equal(await workflowFs.pathExists(workflowsRoot), true);
  assert.equal(await workflowFs.pathExists(workflowFs.getPublishedSnapshotsRoot(workflowsRoot)), true);
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

test('published and latest workflows inject request headers into context', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'HeadersContext');
  await writeHeadersContextEchoProject(created.absolutePath, 'HeadersContext');

  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'headers-context-endpoint',
  });

  await withWorkflowExecutionServer(async ({ publishedBaseUrl, latestBaseUrl }) => {
    const requestHeaders = {
      'Content-Type': 'application/json',
      'X-Storyteller-Header': 'published-request-header',
    };

    const publishedResponse = await fetch(`${publishedBaseUrl}/headers-context-endpoint`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ ignored: true }),
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(publishedResponse.ok, true);

    const publishedBody = await publishedResponse.json() as Record<string, unknown>;
    assert.equal(publishedBody['x-storyteller-header'], 'published-request-header');
    assert.equal(publishedBody['content-type'], 'application/json');
    assert.equal(typeof publishedBody.durationMs, 'number');

    const latestResponse = await fetch(`${latestBaseUrl}/headers-context-endpoint`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ ignored: true }),
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(latestResponse.ok, true);

    const latestBody = await latestResponse.json() as Record<string, unknown>;
    assert.equal(latestBody['x-storyteller-header'], 'published-request-header');
    assert.equal(latestBody['content-type'], 'application/json');
    assert.equal(typeof latestBody.durationMs, 'number');
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
    workflowsRoot,
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
    workflowsRoot,
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
  assert.equal(workflowsResponse.workflows[0]?.suspiciousRuns, 1);
});

test('workflow recording delete route removes a single recording and updates totals', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DeleteOneRecording');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'delete-one-recording-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl }) => {
    for (let index = 0; index < 2; index++) {
      const response = await fetch(`${publishedBaseUrl}/delete-one-recording-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: index }),
      });
      assert.equal(response.ok, true);
    }

    const workflowsResponse = await waitForRecordingWorkflows(
      apiBaseUrl,
      (workflows) => workflows[0]?.totalRuns === 2,
    ) as {
      workflows: Array<{ workflowId: string; totalRuns: number }>;
    };
    const workflowId = workflowsResponse.workflows[0]!.workflowId;

    const runsResponse = await readJson<{
      totalRuns: number;
      runs: Array<{ id: string }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowId)}/runs?page=1&pageSize=20&status=all`));

    assert.equal(runsResponse.totalRuns, 2);
    assert.equal(runsResponse.runs.length, 2);
    const deletedRecordingId = runsResponse.runs[0]!.id;
    const recordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(workflowFs.getWorkflowRecordingsRoot(workflowsRoot), workflowId);
    const deletedBundlePath = path.join(recordingsRoot, deletedRecordingId);
    assert.equal(await workflowFs.pathExists(deletedBundlePath), true);

    const deleteResponse = await fetch(
      `${apiBaseUrl}/recordings/${encodeURIComponent(deletedRecordingId)}`,
      { method: 'DELETE' },
    );

    assert.equal(deleteResponse.ok, true);

    const updatedWorkflows = await readJson<{
      workflows: Array<{ workflowId: string; totalRuns: number }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows`));
    const updatedRuns = await readJson<{
      totalRuns: number;
      runs: Array<{ id: string }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowId)}/runs?page=1&pageSize=20&status=all`));

    assert.equal(updatedWorkflows.workflows[0]?.totalRuns, 1);
    assert.equal(updatedRuns.totalRuns, 1);
    assert.equal(updatedRuns.runs.length, 1);
    assert.notEqual(updatedRuns.runs[0]?.id, deletedRecordingId);
    assert.equal(await workflowFs.pathExists(deletedBundlePath), false);

    const deletedArtifactResponse = await fetch(
      `${apiBaseUrl}/recordings/${encodeURIComponent(deletedRecordingId)}/recording`,
    );
    assert.equal(deletedArtifactResponse.status, 404);
  });
});

test('workflow recording delete route removes the last unpublished recording from disk and index', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DeleteLastRecording');
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, {
    endpointName: 'delete-last-recording-endpoint',
  });

  await withWorkflowExecutionServer(async ({ apiBaseUrl, publishedBaseUrl }) => {
    const response = await fetch(`${publishedBaseUrl}/delete-last-recording-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'only-run' }),
    });
    assert.equal(response.ok, true);

    await workflowMutations.unpublishWorkflowProjectItem(created.relativePath);

    const workflowsResponse = await waitForRecordingWorkflows(
      apiBaseUrl,
      (workflows) => workflows[0]?.totalRuns === 1,
    ) as {
      workflows: Array<{ workflowId: string; totalRuns: number }>;
    };
    const workflowId = workflowsResponse.workflows[0]!.workflowId;

    const runsResponse = await readJson<{
      totalRuns: number;
      runs: Array<{ id: string }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows/${encodeURIComponent(workflowId)}/runs?page=1&pageSize=20&status=all`));

    assert.equal(runsResponse.totalRuns, 1);
    const deletedRecordingId = runsResponse.runs[0]!.id;
    const workflowRecordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(workflowFs.getWorkflowRecordingsRoot(workflowsRoot), workflowId);
    const deletedBundlePath = path.join(workflowRecordingsRoot, deletedRecordingId);

    assert.equal(await workflowFs.pathExists(deletedBundlePath), true);
    assert.equal(await workflowFs.pathExists(workflowRecordingsRoot), true);

    const deleteResponse = await fetch(
      `${apiBaseUrl}/recordings/${encodeURIComponent(deletedRecordingId)}`,
      { method: 'DELETE' },
    );
    assert.equal(deleteResponse.ok, true);

    const updatedWorkflows = await readJson<{
      workflows: Array<{ workflowId: string; totalRuns: number }>;
    }>(await fetch(`${apiBaseUrl}/recordings/workflows`));

    assert.equal(updatedWorkflows.workflows.length, 0);
    assert.equal(await workflowFs.pathExists(deletedBundlePath), false);
    assert.equal(await workflowFs.pathExists(workflowRecordingsRoot), false);

    const deletedRecordingArtifactResponse = await fetch(
      `${apiBaseUrl}/recordings/${encodeURIComponent(deletedRecordingId)}/recording`,
    );
    const deletedProjectArtifactResponse = await fetch(
      `${apiBaseUrl}/recordings/${encodeURIComponent(deletedRecordingId)}/replay-project`,
    );

    assert.equal(deletedRecordingArtifactResponse.status, 404);
    assert.equal(deletedProjectArtifactResponse.status, 404);
  });
});

test('workflow recording persistence snapshots the executed in-memory project state', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'Stable');
  const [loadedProject, attachedData] = await rivetNode.loadProjectAndAttachedDataFromFile(created.absolutePath);
  const mutatedContents = (await fs.readFile(created.absolutePath, 'utf8')).replace('Stable', 'Mutated');

  await fs.writeFile(created.absolutePath, mutatedContents, 'utf8');

  await workflowRecordings.persistWorkflowExecutionRecording({
    workflowsRoot,
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

  const recordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(workflowFs.getWorkflowRecordingsRoot(workflowsRoot), loadedProject.metadata.id);
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
        workflowsRoot,
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

    const recordingsRoot = workflowFs.getWorkflowProjectRecordingsRoot(workflowFs.getWorkflowRecordingsRoot(workflowsRoot), workflowId);
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
