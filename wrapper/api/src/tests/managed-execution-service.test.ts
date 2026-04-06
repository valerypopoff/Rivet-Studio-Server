import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';
import { ManagedWorkflowExecutionCache } from '../routes/workflows/managed/execution-cache.js';
import { ManagedWorkflowExecutionInvalidationController } from '../routes/workflows/managed/execution-invalidation.js';
import { ManagedWorkflowExecutionService } from '../routes/workflows/managed/execution-service.js';
import { getManagedWorkflowProjectVirtualPath } from '../routes/workflows/virtual-paths.js';
import type {
  ManagedExecutionPointerLookupResult,
  ManagedExecutionRevisionRecord,
  ManagedExecutionWorkflowRecord,
} from '../routes/workflows/managed/execution-types.js';

class FakeListener {
  notificationHandler: ((message: { channel: string; payload?: string | null }) => void) | null = null;
  errorHandler: ((error: unknown) => void) | null = null;
  endHandler: (() => void) | null = null;

  async connect(): Promise<this> {
    return this;
  }

  async query(): Promise<void> {
  }

  async end(): Promise<void> {
  }

  on(event: 'notification' | 'error' | 'end', handler: (...args: any[]) => void): void {
    if (event === 'notification') {
      this.notificationHandler = handler as (message: { channel: string; payload?: string | null }) => void;
      return;
    }

    if (event === 'error') {
      this.errorHandler = handler as (error: unknown) => void;
      return;
    }

    this.endHandler = handler as () => void;
  }

  removeAllListeners(): void {
    this.notificationHandler = null;
    this.errorHandler = null;
    this.endHandler = null;
  }

  emitError(error: unknown): void {
    this.errorHandler?.(error);
  }
}

function createControllerFixture() {
  const listener = new FakeListener();
  const controller = new ManagedWorkflowExecutionInvalidationController({
    databaseConnectionConfig: {},
    withManagedDbRetry: async (_scope, run) => run(),
    invalidateWorkflowEndpointPointers: () => {},
    clearEndpointPointers: () => {},
    createListener: () => listener,
    scheduleReconnect: () => ({}),
  });

  return {
    controller,
    listener,
  };
}

function createExecutionServiceFixture(options: {
  resolveExecutionPointerFromDatabase?: (lookupName: string) => Promise<ManagedExecutionPointerLookupResult | null>;
  getWorkflowByRelativePath?: (relativePath: string) => Promise<ManagedExecutionWorkflowRecord | null>;
  getWorkflowById?: (workflowId: string) => Promise<ManagedExecutionWorkflowRecord | null>;
  getRevision?: (revisionId: string | null | undefined) => Promise<ManagedExecutionRevisionRecord | null>;
  readRevisionContents?: (revision: ManagedExecutionRevisionRecord) => Promise<{ contents: string; datasetsContents: string | null }>;
}) {
  const cache = new ManagedWorkflowExecutionCache();
  const { controller, listener } = createControllerFixture();
  const projectContents = createBlankProjectFile('Managed Cache');
  const workflow: ManagedExecutionWorkflowRecord = {
    workflow_id: 'workflow-a',
    relative_path: 'Managed Cache.rivet-project',
    current_draft_revision_id: 'revision-a',
    published_revision_id: 'revision-a',
  };
  const revision: ManagedExecutionRevisionRecord = {
    revision_id: 'revision-a',
    workflow_id: 'workflow-a',
    project_blob_key: 'project-blob',
    dataset_blob_key: null,
    created_at: new Date(),
  };
  let resolveCount = 0;
  let readRevisionContentsCount = 0;
  let getWorkflowByRelativePathCount = 0;
  let getWorkflowByIdCount = 0;

  const service = new ManagedWorkflowExecutionService({
    pool: {} as Pool,
    blobStore: {
      async getText() {
        throw new Error('Unexpected blob-store read');
      },
    },
    executionCache: cache,
    invalidationController: controller,
    getWorkflowByRelativePath: async (_client, relativePath) => {
      getWorkflowByRelativePathCount += 1;
      return options.getWorkflowByRelativePath
        ? options.getWorkflowByRelativePath(relativePath)
        : relativePath === workflow.relative_path
          ? workflow
          : null;
    },
    getWorkflowById: async (_client, workflowId) => {
      getWorkflowByIdCount += 1;
      return options.getWorkflowById
        ? options.getWorkflowById(workflowId)
        : workflowId === workflow.workflow_id
          ? workflow
          : null;
    },
    getRevision: async (_client, revisionId) => options.getRevision ? options.getRevision(revisionId) : revisionId === revision.revision_id ? revision : null,
    readRevisionContents: async (loadedRevision) => {
      readRevisionContentsCount += 1;
      return options.readRevisionContents
        ? options.readRevisionContents(loadedRevision)
        : {
            contents: projectContents,
            datasetsContents: null,
          };
    },
    resolveExecutionPointerFromDatabase: async (_client, _runKind, lookupName) => {
      resolveCount += 1;
      return options.resolveExecutionPointerFromDatabase
        ? options.resolveExecutionPointerFromDatabase(lookupName)
        : {
            pointer: {
              workflowId: workflow.workflow_id,
              relativePath: workflow.relative_path,
              revisionId: revision.revision_id,
            },
            revision,
          };
    },
  });

  return {
    cache,
    controller,
    listener,
    service,
    workflow,
    revision,
    projectContents,
    get resolveCount() {
      return resolveCount;
    },
    get readRevisionContentsCount() {
      return readRevisionContentsCount;
    },
    get getWorkflowByRelativePathCount() {
      return getWorkflowByRelativePathCount;
    },
    get getWorkflowByIdCount() {
      return getWorkflowByIdCount;
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    resolve,
  };
}

test('warm pointer hit does not re-run joined DB resolution', async () => {
  const fixture = createExecutionServiceFixture({});
  await fixture.controller.initialize();

  const first = await fixture.service.loadPublishedExecutionProject('hello-world');
  const second = await fixture.service.loadPublishedExecutionProject('hello-world');

  assert.ok(first);
  assert.ok(second);
  assert.equal(fixture.resolveCount, 1);
  assert.equal(fixture.readRevisionContentsCount, 1);
});

test('pointer misses are not cached as null', async () => {
  let callCount = 0;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      callCount += 1;
      if (callCount === 1) {
        return null;
      }

      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
        },
        revision: {
          revision_id: 'revision-a',
          workflow_id: 'workflow-a',
          project_blob_key: 'project-blob',
          dataset_blob_key: null,
          created_at: new Date(),
        },
      };
    },
  });
  await fixture.controller.initialize();

  assert.equal(await fixture.service.loadPublishedExecutionProject('hello-world'), null);
  assert.ok(await fixture.service.loadPublishedExecutionProject('hello-world'));
  assert.equal(callCount, 2);
});

test('post-invalidation requests do not join a pre-invalidation endpoint miss', async () => {
  const firstResolve = createDeferred<ManagedExecutionPointerLookupResult>();
  let resolveInvocation = 0;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      resolveInvocation += 1;
      if (resolveInvocation === 1) {
        return firstResolve.promise;
      }

      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
        },
        revision: fixture.revision,
      };
    },
  });
  await fixture.controller.initialize();

  const firstLoad = fixture.service.loadPublishedExecutionProject('hello-world');
  fixture.controller.markWorkflowChanged('workflow-a');
  const secondLoad = fixture.service.loadPublishedExecutionProject('hello-world');

  firstResolve.resolve({
    pointer: {
      workflowId: 'workflow-a',
      relativePath: 'Managed Cache.rivet-project',
      revisionId: 'revision-a',
    },
    revision: fixture.revision,
  });

  await Promise.allSettled([firstLoad, secondLoad]);
  assert.equal(resolveInvocation >= 2, true);
});

test('unrelated workflow churn does not force retry after the workflow id is already known', async () => {
  const fixture = createExecutionServiceFixture({
    readRevisionContents: async (revision) => {
      fixture.controller.markWorkflowChanged('workflow-b');
      return {
        contents: fixture.projectContents,
        datasetsContents: null,
      };
    },
  });
  await fixture.controller.initialize();

  const result = await fixture.service.loadPublishedExecutionProject('hello-world');
  assert.ok(result);
  assert.equal(fixture.resolveCount, 1);
});

test('same-workflow change during resolve retries correctly', async () => {
  let resolveInvocation = 0;
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      resolveInvocation += 1;
      if (resolveInvocation === 1) {
        fixture.controller.markWorkflowChanged('workflow-a');
      }

      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
        },
        revision: fixture.revision,
      };
    },
  });
  await fixture.controller.initialize();

  const result = await fixture.service.loadPublishedExecutionProject('hello-world');
  assert.ok(result);
  assert.equal(resolveInvocation, 2);
});

test('same-workflow change during materialization retries correctly', async () => {
  let readInvocation = 0;
  const fixture = createExecutionServiceFixture({
    readRevisionContents: async () => {
      readInvocation += 1;
      if (readInvocation === 1) {
        fixture.controller.markWorkflowChanged('workflow-a');
      }

      return {
        contents: fixture.projectContents,
        datasetsContents: null,
      };
    },
  });
  await fixture.controller.initialize();

  const result = await fixture.service.loadPublishedExecutionProject('hello-world');
  assert.ok(result);
  assert.equal(fixture.resolveCount, 2);
});

test('repeated same-workflow races eventually fail instead of returning stale data', async () => {
  const fixture = createExecutionServiceFixture({
    resolveExecutionPointerFromDatabase: async () => {
      fixture.controller.markWorkflowChanged('workflow-a');
      return {
        pointer: {
          workflowId: 'workflow-a',
          relativePath: 'Managed Cache.rivet-project',
          revisionId: 'revision-a',
        },
        revision: fixture.revision,
      };
    },
  });
  await fixture.controller.initialize();

  await assert.rejects(
    fixture.service.loadPublishedExecutionProject('hello-world'),
    /Workflow endpoint changed while loading\. Retry the request\./,
  );
});

test('listener-unhealthy mode bypasses pointer cache but still reuses revision materialization cache', async () => {
  const fixture = createExecutionServiceFixture({});
  await fixture.controller.initialize();

  await fixture.service.loadPublishedExecutionProject('hello-world');
  fixture.listener.emitError(new Error('boom'));
  await Promise.resolve();

  await fixture.service.loadPublishedExecutionProject('hello-world');
  assert.equal(fixture.resolveCount, 2);
  assert.equal(fixture.readRevisionContentsCount, 1);
});

test('reference loading reuses revision materialization cache once the revision id is known', async () => {
  const fixture = createExecutionServiceFixture({});
  await fixture.controller.initialize();
  const loader = fixture.service.createProjectReferenceLoader();

  const currentProjectPath = getManagedWorkflowProjectVirtualPath('Main.rivet-project');
  const first = await loader.loadProject(currentProjectPath, {
    id: fixture.workflow.workflow_id,
    hintPaths: ['./Managed Cache.rivet-project'],
    title: 'Managed Cache',
  });
  const second = await loader.loadProject(currentProjectPath, {
    id: fixture.workflow.workflow_id,
    hintPaths: ['./Managed Cache.rivet-project'],
    title: 'Managed Cache',
  });

  assert.equal(first.metadata.title, second.metadata.title);
  assert.equal(fixture.readRevisionContentsCount, 1);
  assert.equal(fixture.getWorkflowByRelativePathCount, 2);
});

test('reference loading propagates real operational failures after a hint resolves to a real workflow', async () => {
  const fixture = createExecutionServiceFixture({
    readRevisionContents: async () => {
      throw new Error('blob read failed');
    },
  });
  await fixture.controller.initialize();
  const loader = fixture.service.createProjectReferenceLoader();

  await assert.rejects(
    loader.loadProject(getManagedWorkflowProjectVirtualPath('Main.rivet-project'), {
      id: fixture.workflow.workflow_id,
      hintPaths: ['./Managed Cache.rivet-project'],
      title: 'Managed Cache',
    }),
    /blob read failed/,
  );
});
