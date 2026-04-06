import { performance } from 'node:perf_hooks';
import { NodeDatasetProvider, deserializeDatasets, loadProjectAndAttachedDataFromString, loadProjectFromString, type Project } from '@ironclad/rivet-node';
import type { Pool } from 'pg';

import { createHttpError } from '../../../utils/httpError.js';
import { normalizeWorkflowEndpointLookupName } from '../publication.js';
import { getManagedWorkflowProjectVirtualPath, resolveManagedWorkflowRelativeReference } from '../virtual-paths.js';
import {
  ManagedWorkflowExecutionInvalidationController,
  MANAGED_WORKFLOW_EXECUTION_INVALIDATION_RETRY_LIMIT,
} from './execution-invalidation.js';
import { ManagedWorkflowExecutionCache, type ManagedRevisionMaterializationCacheEntry, type ManagedWorkflowRunKind } from './execution-cache.js';
import type {
  ManagedExecutionProjectResult,
  ManagedExecutionPointerLookupResult,
  ManagedExecutionResolveSnapshot,
  ManagedExecutionRevisionRecord,
  ManagedExecutionWorkflowRecord,
} from './execution-types.js';

type ManagedWorkflowExecutionBlobStore = {
  getText(key: string): Promise<string>;
};

type ManagedWorkflowExecutionServiceDependencies = {
  pool: Pool;
  blobStore: ManagedWorkflowExecutionBlobStore;
  executionCache: ManagedWorkflowExecutionCache;
  invalidationController: ManagedWorkflowExecutionInvalidationController;
  getWorkflowByRelativePath(client: Pool, relativePath: string): Promise<ManagedExecutionWorkflowRecord | null>;
  getWorkflowById(client: Pool, workflowId: string): Promise<ManagedExecutionWorkflowRecord | null>;
  getRevision(client: Pool, revisionId: string | null | undefined): Promise<ManagedExecutionRevisionRecord | null>;
  readRevisionContents?(revision: ManagedExecutionRevisionRecord): Promise<{ contents: string; datasetsContents: string | null }>;
  resolveExecutionPointerFromDatabase(
    client: Pool,
    runKind: ManagedWorkflowRunKind,
    lookupName: string,
  ): Promise<ManagedExecutionPointerLookupResult | null>;
};

export class ManagedWorkflowExecutionService {
  readonly #pool: Pool;
  readonly #blobStore: ManagedWorkflowExecutionBlobStore;
  readonly #executionCache: ManagedWorkflowExecutionCache;
  readonly #invalidationController: ManagedWorkflowExecutionInvalidationController;
  readonly #getWorkflowByRelativePath: ManagedWorkflowExecutionServiceDependencies['getWorkflowByRelativePath'];
  readonly #getWorkflowById: ManagedWorkflowExecutionServiceDependencies['getWorkflowById'];
  readonly #getRevision: ManagedWorkflowExecutionServiceDependencies['getRevision'];
  readonly #readRevisionContents: NonNullable<ManagedWorkflowExecutionServiceDependencies['readRevisionContents']>;
  readonly #resolveExecutionPointerFromDatabase: ManagedWorkflowExecutionServiceDependencies['resolveExecutionPointerFromDatabase'];
  readonly #endpointLoadInflight = new Map<string, Promise<ManagedExecutionProjectResult | null>>();
  readonly #revisionMaterializationInflight = new Map<string, Promise<ManagedRevisionMaterializationCacheEntry>>();

  constructor(dependencies: ManagedWorkflowExecutionServiceDependencies) {
    this.#pool = dependencies.pool;
    this.#blobStore = dependencies.blobStore;
    this.#executionCache = dependencies.executionCache;
    this.#invalidationController = dependencies.invalidationController;
    this.#getWorkflowByRelativePath = dependencies.getWorkflowByRelativePath;
    this.#getWorkflowById = dependencies.getWorkflowById;
    this.#getRevision = dependencies.getRevision;
    this.#readRevisionContents = dependencies.readRevisionContents ?? ((revision) => this.#readRevisionContentsFromBlobStore(revision));
    this.#resolveExecutionPointerFromDatabase = dependencies.resolveExecutionPointerFromDatabase;
  }

  async loadPublishedExecutionProject(endpointName: string): Promise<ManagedExecutionProjectResult | null> {
    return this.#loadExecutionProjectByEndpoint('published', endpointName);
  }

  async loadLatestExecutionProject(endpointName: string): Promise<ManagedExecutionProjectResult | null> {
    return this.#loadExecutionProjectByEndpoint('latest', endpointName);
  }

  createProjectReferenceLoader() {
    const service = this;

    return {
      async loadProject(currentProjectPath: string | undefined, reference: { id: string; hintPaths?: string[]; title?: string }) {
        if (!currentProjectPath) {
          throw new Error(`Could not load project "${reference.title ?? reference.id}" because the current project path is missing.`);
        }

        for (const hintPath of reference.hintPaths ?? []) {
          let relativePath: string;
          try {
            relativePath = resolveManagedWorkflowRelativeReference(currentProjectPath, hintPath);
          } catch {
            continue;
          }

          const project = await service.#loadExecutionReferencedProjectByRelativePath(relativePath);
          if (project) {
            return project;
          }
        }

        const workflowById = await service.#loadExecutionReferencedProjectById(reference.id);
        if (workflowById) {
          return workflowById;
        }

        throw new Error(`Could not load project "${reference.title ?? reference.id} (${reference.id})": all hint paths failed.`);
      },
    };
  }

  async #loadExecutionProjectByEndpoint(
    runKind: ManagedWorkflowRunKind,
    endpointName: string,
  ): Promise<ManagedExecutionProjectResult | null> {
    const lookupName = normalizeWorkflowEndpointLookupName(endpointName);
    const endpointCacheKey = `${runKind}:${lookupName}`;
    const resolveSnapshot = this.#invalidationController.captureResolveSnapshot();
    const endpointLoadInflightKey = `${endpointCacheKey}:${resolveSnapshot.anyGeneration}`;
    const existingLoad = this.#endpointLoadInflight.get(endpointLoadInflightKey);
    if (existingLoad) {
      return existingLoad;
    }

    const loadPromise = this.#loadExecutionProjectByEndpointOnce(runKind, lookupName)
      .finally(() => {
        this.#endpointLoadInflight.delete(endpointLoadInflightKey);
      });
    this.#endpointLoadInflight.set(endpointLoadInflightKey, loadPromise);
    return loadPromise;
  }

  async #loadExecutionProjectByEndpointOnce(
    runKind: ManagedWorkflowRunKind,
    lookupName: string,
    options: {
      forceBypassPointerCache?: boolean;
      allowPointerFallback?: boolean;
      remainingInvalidationRetries?: number;
    } = {},
  ): Promise<ManagedExecutionProjectResult | null> {
    const remainingInvalidationRetries = options.remainingInvalidationRetries ?? MANAGED_WORKFLOW_EXECUTION_INVALIDATION_RETRY_LIMIT;
    const resolveSnapshot = this.#invalidationController.captureResolveSnapshot();
    const resolveStartedAt = performance.now();
    const endpointCacheKey = `${runKind}:${lookupName}`;
    const canUsePointerCache = this.#invalidationController.isPointerCacheHealthy() && !options.forceBypassPointerCache;
    const cachedPointer = canUsePointerCache
      ? this.#executionCache.getEndpointPointer(endpointCacheKey)
      : null;
    let pointer = cachedPointer;
    let revision: ManagedExecutionRevisionRecord | null = null;
    let workflowSnapshot = cachedPointer
      ? this.#invalidationController.captureWorkflowSnapshot(cachedPointer.workflowId)
      : null;
    const cacheStatus = cachedPointer
      ? 'hit'
      : this.#invalidationController.isPointerCacheHealthy() && !options.forceBypassPointerCache
        ? 'miss'
        : 'bypass';

    if (!pointer) {
      const resolved = await this.#resolveExecutionPointerFromDatabase(this.#pool, runKind, lookupName);
      if (!resolved) {
        if (this.#invalidationController.shouldRetryAfterResolve(resolveSnapshot, null) && remainingInvalidationRetries > 0) {
          return this.#loadExecutionProjectByEndpointOnce(runKind, lookupName, {
            forceBypassPointerCache: true,
            remainingInvalidationRetries: remainingInvalidationRetries - 1,
          });
        }

        return null;
      }

      pointer = resolved.pointer;
      revision = resolved.revision;
      workflowSnapshot = this.#invalidationController.captureWorkflowSnapshot(pointer.workflowId);

      if (this.#invalidationController.shouldRetryAfterResolve(resolveSnapshot, pointer.workflowId)) {
        if (remainingInvalidationRetries > 0) {
          return this.#loadExecutionProjectByEndpointOnce(runKind, lookupName, {
            forceBypassPointerCache: true,
            remainingInvalidationRetries: remainingInvalidationRetries - 1,
          });
        }

        throw createHttpError(503, 'Workflow endpoint changed while loading. Retry the request.');
      }

      if (canUsePointerCache) {
        this.#executionCache.setEndpointPointer(endpointCacheKey, pointer);
      }
    }

    const resolveMs = Math.max(0, Math.round(performance.now() - resolveStartedAt));
    this.#invalidationController.beginWorkflowLoad(pointer.workflowId);
    try {
      const materializeStartedAt = performance.now();

      let materialization: ManagedRevisionMaterializationCacheEntry;
      try {
        materialization = await this.#getOrLoadRevisionMaterialization(pointer.revisionId, revision);
      } catch (error) {
        const isMissingRevision = typeof error === 'object' &&
          error != null &&
          'status' in error &&
          Number((error as { status?: unknown }).status) === 404;

        if (cachedPointer && options.allowPointerFallback !== false && isMissingRevision) {
          this.#invalidationController.markWorkflowChanged(pointer.workflowId);
          return this.#loadExecutionProjectByEndpointOnce(runKind, lookupName, {
            forceBypassPointerCache: true,
            allowPointerFallback: false,
            remainingInvalidationRetries,
          });
        }

        throw error;
      }

      if (workflowSnapshot && this.#invalidationController.shouldRetryAfterMaterialize(resolveSnapshot, pointer.workflowId, workflowSnapshot)) {
        if (remainingInvalidationRetries > 0) {
          return this.#loadExecutionProjectByEndpointOnce(runKind, lookupName, {
            forceBypassPointerCache: true,
            remainingInvalidationRetries: remainingInvalidationRetries - 1,
          });
        }

        throw createHttpError(503, 'Workflow endpoint changed while loading. Retry the request.');
      }

      const [project, attachedData] = loadProjectAndAttachedDataFromString(materialization.contents);
      const datasetProvider = new NodeDatasetProvider(
        materialization.datasetsContents ? deserializeDatasets(materialization.datasetsContents) : [],
      );

      if (workflowSnapshot && this.#invalidationController.shouldRetryAfterMaterialize(resolveSnapshot, pointer.workflowId, workflowSnapshot)) {
        if (remainingInvalidationRetries > 0) {
          return this.#loadExecutionProjectByEndpointOnce(runKind, lookupName, {
            forceBypassPointerCache: true,
            remainingInvalidationRetries: remainingInvalidationRetries - 1,
          });
        }

        throw createHttpError(503, 'Workflow endpoint changed while loading. Retry the request.');
      }

      return {
        project,
        attachedData,
        datasetProvider,
        projectVirtualPath: getManagedWorkflowProjectVirtualPath(pointer.relativePath),
        debug: {
          cacheStatus,
          resolveMs,
          materializeMs: Math.max(0, Math.round(performance.now() - materializeStartedAt)),
        },
      };
    } finally {
      this.#invalidationController.endWorkflowLoad(pointer.workflowId);
    }
  }

  async #getOrLoadRevisionMaterialization(
    revisionId: string,
    knownRevision: ManagedExecutionRevisionRecord | null,
  ): Promise<ManagedRevisionMaterializationCacheEntry> {
    const cached = this.#executionCache.getRevisionMaterialization(revisionId);
    if (cached) {
      return cached;
    }

    const existingLoad = this.#revisionMaterializationInflight.get(revisionId);
    if (existingLoad) {
      return existingLoad;
    }

    const loadPromise = (async () => {
      const revision = knownRevision ?? await this.#getRevision(this.#pool, revisionId);
      if (!revision) {
        throw createHttpError(404, 'Project revision not found');
      }

      const contents = await this.#readRevisionContents(revision);
      const materialization = {
        revisionId,
        contents: contents.contents,
        datasetsContents: contents.datasetsContents,
      } satisfies ManagedRevisionMaterializationCacheEntry;
      this.#executionCache.setRevisionMaterialization(materialization);
      return materialization;
    })()
      .finally(() => {
        this.#revisionMaterializationInflight.delete(revisionId);
      });

    this.#revisionMaterializationInflight.set(revisionId, loadPromise);
    return loadPromise;
  }

  async #loadExecutionReferencedProjectByRelativePath(
    relativePath: string,
    options: {
      remainingInvalidationRetries?: number;
    } = {},
  ): Promise<Project | null> {
    return this.#loadExecutionReferencedProject(
      () => this.#getWorkflowByRelativePath(this.#pool, relativePath),
      options,
    );
  }

  async #loadExecutionReferencedProjectById(
    workflowId: string,
    options: {
      remainingInvalidationRetries?: number;
    } = {},
  ): Promise<Project | null> {
    return this.#loadExecutionReferencedProject(
      () => this.#getWorkflowById(this.#pool, workflowId),
      options,
    );
  }

  async #loadExecutionReferencedProject(
    loadWorkflow: () => Promise<ManagedExecutionWorkflowRecord | null>,
    options: {
      remainingInvalidationRetries?: number;
    } = {},
  ): Promise<Project | null> {
    const remainingInvalidationRetries = options.remainingInvalidationRetries ?? MANAGED_WORKFLOW_EXECUTION_INVALIDATION_RETRY_LIMIT;
    const resolveSnapshot = this.#invalidationController.captureResolveSnapshot();
    const workflow = await loadWorkflow();
    if (!workflow) {
      return null;
    }

    if (this.#invalidationController.shouldRetryAfterResolve(resolveSnapshot, workflow.workflow_id)) {
      if (remainingInvalidationRetries > 0) {
        return this.#loadExecutionReferencedProject(loadWorkflow, {
          remainingInvalidationRetries: remainingInvalidationRetries - 1,
        });
      }

      throw createHttpError(503, 'Referenced workflow changed while loading. Retry the request.');
    }

    const revisionId = workflow.published_revision_id ?? workflow.current_draft_revision_id;
    if (!revisionId) {
      return null;
    }

    const workflowSnapshot = this.#invalidationController.captureWorkflowSnapshot(workflow.workflow_id);
    this.#invalidationController.beginWorkflowLoad(workflow.workflow_id);
    try {
      const materialization = await this.#getOrLoadRevisionMaterialization(revisionId, null);
      if (this.#invalidationController.shouldRetryAfterMaterialize(resolveSnapshot, workflow.workflow_id, workflowSnapshot)) {
        if (remainingInvalidationRetries > 0) {
          return this.#loadExecutionReferencedProject(loadWorkflow, {
            remainingInvalidationRetries: remainingInvalidationRetries - 1,
          });
        }

        throw createHttpError(503, 'Referenced workflow changed while loading. Retry the request.');
      }

      const project = loadProjectFromString(materialization.contents);
      if (this.#invalidationController.shouldRetryAfterMaterialize(resolveSnapshot, workflow.workflow_id, workflowSnapshot)) {
        if (remainingInvalidationRetries > 0) {
          return this.#loadExecutionReferencedProject(loadWorkflow, {
            remainingInvalidationRetries: remainingInvalidationRetries - 1,
          });
        }

        throw createHttpError(503, 'Referenced workflow changed while loading. Retry the request.');
      }

      return project;
    } finally {
      this.#invalidationController.endWorkflowLoad(workflow.workflow_id);
    }
  }

  async #readRevisionContentsFromBlobStore(
    revision: ManagedExecutionRevisionRecord,
  ): Promise<{ contents: string; datasetsContents: string | null }> {
    const [contents, datasetsContents] = await Promise.all([
      this.#blobStore.getText(revision.project_blob_key),
      revision.dataset_blob_key ? this.#blobStore.getText(revision.dataset_blob_key) : Promise.resolve(null),
    ]);

    return {
      contents,
      datasetsContents,
    };
  }
}
