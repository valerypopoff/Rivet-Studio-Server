import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  loadProjectAndAttachedDataFromString,
  serializeDatasets,
  serializeProject,
} from '@ironclad/rivet-node';

import type {
  WorkflowFolderItem,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
} from '../../../../../shared/workflow-types.js';
import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingRunSummary,
  WorkflowRecordingWorkflowListResponse,
} from '../../../../../shared/workflow-recording-types.js';
import { badRequest, conflict, createHttpError } from '../../../utils/httpError.js';
import { normalizeStoredEndpointName, normalizeWorkflowEndpointLookupName } from '../publication.js';
import type { ManagedWorkflowStorageConfig } from '../storage-config.js';
import {
  getManagedWorkflowFolderVirtualPath,
  getManagedWorkflowProjectVirtualPath,
} from '../virtual-paths.js';
import {
  S3ManagedWorkflowBlobStore,
  createManagedRevisionId,
  createRecordingBlobKey,
  createRevisionBlobKey,
  type ManagedWorkflowBlobStore,
} from './blob-store.js';
import { createManagedWorkflowCatalogService } from './catalog.js';
import { ManagedWorkflowExecutionCache } from './execution-cache.js';
import type {
  ManagedExecutionPointerLookupResult,
  ManagedExecutionProjectResult,
} from './execution-types.js';
import { ManagedWorkflowExecutionInvalidationController } from './execution-invalidation.js';
import { ManagedWorkflowExecutionService } from './execution-service.js';
import { createManagedWorkflowPublicationService } from './publication.js';
import { createManagedWorkflowRecordingService } from './recordings.js';
import { createManagedWorkflowRevisionService } from './revisions.js';
import { MANAGED_WORKFLOW_SCHEMA_SQL } from './schema.js';
import type {
  CurrentDraftRevisionRow,
  FolderRow,
  ImportManagedWorkflowOptions,
  ImportManagedWorkflowRecordingOptions,
  LoadHostedProjectResult,
  ManagedRevisionContents,
  PersistWorkflowExecutionRecordingOptions,
  RecordingBlobArtifacts,
  RecordingBlobKeys,
  RecordingInsertRowData,
  RecordingRow,
  RevisionRow,
  SaveHostedProjectResult,
  TransactionHooks,
  WorkflowRecordingListRow,
  WorkflowRow,
} from './types.js';

function withTablePrefix(columnNames: readonly string[], tableAlias: string): string {
  return columnNames.map((columnName) => `${tableAlias}.${columnName}`).join(', ');
}

const WORKFLOW_COLUMN_NAMES = [
  'workflow_id',
  'name',
  'file_name',
  'relative_path',
  'folder_relative_path',
  'updated_at',
  'current_draft_revision_id',
  'published_revision_id',
  'endpoint_name',
  'published_endpoint_name',
  'last_published_at',
] as const;

const RECORDING_COLUMN_NAMES = [
  'recording_id',
  'workflow_id',
  'source_project_name',
  'source_project_relative_path',
  'created_at',
  'run_kind',
  'status',
  'duration_ms',
  'endpoint_name_at_execution',
  'error_message',
  'recording_blob_key',
  'replay_project_blob_key',
  'replay_dataset_blob_key',
  'has_replay_dataset',
  'recording_compressed_bytes',
  'recording_uncompressed_bytes',
  'project_compressed_bytes',
  'project_uncompressed_bytes',
  'dataset_compressed_bytes',
  'dataset_uncompressed_bytes',
] as const;

const WORKFLOW_COLUMNS = WORKFLOW_COLUMN_NAMES.join(', ');
const WORKFLOW_COLUMNS_QUALIFIED = withTablePrefix(WORKFLOW_COLUMN_NAMES, 'w');
const RECORDING_COLUMNS = RECORDING_COLUMN_NAMES.join(', ');

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' &&
    error != null &&
    'code' in error &&
    String((error as { code?: unknown }).code ?? '') === '23505';
}

function haveMatchingManagedRevisionContents(left: ManagedRevisionContents, right: ManagedRevisionContents): boolean {
  return left.contents === right.contents && left.datasetsContents === right.datasetsContents;
}

export function resolveManagedHostedProjectSaveTarget(options: {
  nextContents: ManagedRevisionContents;
  currentDraftContents: ManagedRevisionContents;
  publishedContents: ManagedRevisionContents | null;
  draftEndpointName: string;
  publishedEndpointName: string;
}): 'current-draft' | 'published-revision' | 'create-revision' {
  const matchesPublishedRevision = options.publishedContents != null &&
    normalizeWorkflowEndpointLookupName(options.draftEndpointName) === normalizeWorkflowEndpointLookupName(options.publishedEndpointName) &&
    haveMatchingManagedRevisionContents(options.nextContents, options.publishedContents);

  if (matchesPublishedRevision) {
    return 'published-revision';
  }

  if (haveMatchingManagedRevisionContents(options.nextContents, options.currentDraftContents)) {
    return 'current-draft';
  }

  return 'create-revision';
}

function getWorkflowStatus(row: WorkflowRow): WorkflowProjectStatus {
  if (!row.published_revision_id) {
    return 'unpublished';
  }

  return row.published_revision_id === row.current_draft_revision_id &&
    normalizeWorkflowEndpointLookupName(row.published_endpoint_name) === normalizeWorkflowEndpointLookupName(row.endpoint_name)
    ? 'published'
    : 'unpublished_changes';
}

function mapWorkflowRowToProjectItem(row: WorkflowRow): WorkflowProjectItem {
  return {
    id: row.workflow_id,
    name: row.name,
    fileName: row.file_name,
    relativePath: row.relative_path,
    absolutePath: getManagedWorkflowProjectVirtualPath(row.relative_path),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
    settings: {
      status: getWorkflowStatus(row),
      endpointName: row.endpoint_name,
      lastPublishedAt: toIsoString(row.last_published_at),
    },
  };
}

function mapFolderRowToFolderItem(row: FolderRow): WorkflowFolderItem {
  return {
    id: row.relative_path,
    name: row.name,
    relativePath: row.relative_path,
    absolutePath: getManagedWorkflowFolderVirtualPath(row.relative_path),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
    folders: [],
    projects: [],
  };
}

function splitCurrentDraftRevisionRow(row: CurrentDraftRevisionRow): { workflow: WorkflowRow; revision: RevisionRow } {
  return {
    workflow: {
      workflow_id: row.workflow_id,
      name: row.name,
      file_name: row.file_name,
      relative_path: row.relative_path,
      folder_relative_path: row.folder_relative_path,
      updated_at: row.updated_at,
      current_draft_revision_id: row.current_draft_revision_id,
      published_revision_id: row.published_revision_id,
      endpoint_name: row.endpoint_name,
      published_endpoint_name: row.published_endpoint_name,
      last_published_at: row.last_published_at,
    },
    revision: {
      revision_id: row.revision_id,
      workflow_id: row.revision_workflow_id,
      project_blob_key: row.project_blob_key,
      dataset_blob_key: row.dataset_blob_key,
      created_at: row.revision_created_at,
    },
  };
}

function getManagedDbConnectionConfig(config: ManagedWorkflowStorageConfig) {
  const sharedConfig = {
    connectionString: config.databaseUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    idleTimeoutMillis: 30_000,
  };

  if (config.databaseSslMode === 'disable') {
    return sharedConfig;
  }

  return {
    ...sharedConfig,
    ssl: {
      rejectUnauthorized: config.databaseSslMode === 'verify-full',
    },
  };
}

function getPoolConfig(config: ManagedWorkflowStorageConfig) {
  return {
    ...getManagedDbConnectionConfig(config),
    max: 10,
  };
}

const RETRYABLE_MANAGED_DB_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const MANAGED_DB_RETRY_ATTEMPTS = 3;

function isRetryableManagedDbError(error: unknown): boolean {
  if (typeof error !== 'object' || error == null || !('code' in error)) {
    return false;
  }

  return RETRYABLE_MANAGED_DB_ERROR_CODES.has(String((error as { code?: unknown }).code ?? ''));
}

async function waitForManagedDbRetry(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function withManagedDbRetry<T>(scope: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MANAGED_DB_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isRetryableManagedDbError(error) || attempt === MANAGED_DB_RETRY_ATTEMPTS) {
        throw error;
      }

      const delayMs = attempt * 250;
      console.warn(
        `[managed-workflows] ${scope} failed with retryable database connection error ` +
        `(${String((error as { code?: unknown }).code ?? 'unknown')}). Retrying in ${delayMs}ms...`,
      );
      await waitForManagedDbRetry(delayMs);
    }
  }

  throw new Error(`[managed-workflows] ${scope} failed without returning a result.`);
}

async function queryRows<T extends QueryResultRow>(client: PoolClient | Pool, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = client instanceof Pool
    ? await withManagedDbRetry('database query', () => client.query<T>(sql, params))
    : await client.query<T>(sql, params);
  return result.rows;
}

async function queryOne<T extends QueryResultRow>(client: PoolClient | Pool, sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await queryRows<T>(client, sql, params);
  return rows[0] ?? null;
}

export class ManagedWorkflowBackend {
  readonly #pool;
  readonly #blobStore;
  readonly #executionCache = new ManagedWorkflowExecutionCache();
  readonly #executionInvalidationController: ManagedWorkflowExecutionInvalidationController;
  readonly #executionService: ManagedWorkflowExecutionService;
  readonly #catalog: ReturnType<typeof createManagedWorkflowCatalogService>;
  readonly #revisions: ReturnType<typeof createManagedWorkflowRevisionService>;
  readonly #publication: ReturnType<typeof createManagedWorkflowPublicationService>;
  readonly #recordings: ReturnType<typeof createManagedWorkflowRecordingService>;
  #schemaReadyPromise: Promise<void> | null = null;
  #disposed = false;

  constructor(config: ManagedWorkflowStorageConfig, blobStore?: ManagedWorkflowBlobStore) {
    const databaseConnectionConfig = getManagedDbConnectionConfig(config);
    this.#pool = new Pool(getPoolConfig(config));
    this.#blobStore = blobStore ?? new S3ManagedWorkflowBlobStore(config);
    this.#executionInvalidationController = new ManagedWorkflowExecutionInvalidationController({
      databaseConnectionConfig,
      withManagedDbRetry,
      invalidateWorkflowEndpointPointers: (workflowId) => {
        this.#executionCache.invalidateWorkflowEndpointPointers(workflowId);
      },
      clearEndpointPointers: () => {
        this.#executionCache.clearEndpointPointers();
      },
    });
    this.#executionService = new ManagedWorkflowExecutionService({
      pool: this.#pool,
      blobStore: this.#blobStore,
      executionCache: this.#executionCache,
      invalidationController: this.#executionInvalidationController,
      getWorkflowByRelativePath: (client, relativePath) => this.#getWorkflowByRelativePath(client, relativePath),
      getWorkflowById: (client, workflowId) => this.#getWorkflowById(client, workflowId),
      getRevision: (client, revisionId) => this.#getRevision(client, revisionId),
      readRevisionContents: (revision) => this.#readRevisionContents(revision as RevisionRow),
      resolveExecutionPointerFromDatabase: (client, runKind, lookupName) => this.#resolveExecutionPointerFromDatabase(client, runKind, lookupName),
    });
    this.#revisions = createManagedWorkflowRevisionService({
      pool: this.#pool,
      initialize: () => this.initialize(),
      withTransaction: (run) => this.#withTransaction(run),
      ensureFolderChain: (client, folderRelativePath) => this.#ensureFolderChain(client, folderRelativePath),
      getWorkflowByRelativePath: (client, relativePath, options) => this.#getWorkflowByRelativePath(client, relativePath, options),
      getWorkflowById: (client, workflowId) => this.#getWorkflowById(client, workflowId),
      getRevision: (client, revisionId) => this.#getRevision(client, revisionId),
      getCurrentDraftWorkflowRevision: (client, relativePath) => this.#getCurrentDraftWorkflowRevision(client, relativePath),
      readRevisionContents: (revision) => this.#readRevisionContents(revision),
      createRevision: (workflowId, contents, datasetsContents) => this.#createRevision(workflowId, contents, datasetsContents),
      scheduleRevisionBlobCleanup: (hooks, revision) => this.#scheduleRevisionBlobCleanup(hooks, revision),
      insertRevision: (client, revision) => this.#insertRevision(client, revision),
      syncWorkflowEndpointRows: (client, workflow, endpoints) => this.#syncWorkflowEndpointRows(client, workflow, endpoints),
      mapWorkflowRowToProjectItem,
      resolveManagedHostedProjectSaveTarget,
      queueWorkflowInvalidation: (client, hooks, workflowId) => this.#executionInvalidationController.queueWorkflowInvalidation(client, hooks, workflowId),
    });
    this.#catalog = createManagedWorkflowCatalogService({
      pool: this.#pool,
      initialize: () => this.initialize(),
      withTransaction: (run) => this.#withTransaction(run),
      queryOne: (client, sql, params) => queryOne(client, sql, params),
      queryRows: (client, sql, params) => queryRows(client, sql, params),
      listFolderRows: (client) => this.#listFolderRows(client),
      listWorkflowRows: (client) => this.#listWorkflowRows(client),
      getWorkflowByRelativePath: (client, relativePath, options) => this.#getWorkflowByRelativePath(client, relativePath, options),
      getCurrentDraftWorkflowRevision: (client, relativePath) => this.#getCurrentDraftWorkflowRevision(client, relativePath),
      getRevision: (client, revisionId) => this.#getRevision(client, revisionId),
      readRevisionContents: (revision) => this.#readRevisionContents(revision),
      assertFolderExists: (client, folderRelativePath) => this.#assertFolderExists(client, folderRelativePath),
      saveHostedProject: (options) => this.#revisions.saveHostedProject(options),
      mapWorkflowRowToProjectItem,
      mapFolderRowToFolderItem,
      getWorkflowStatus,
      blobStore: this.#blobStore,
      queueWorkflowInvalidation: (client, hooks, workflowId) => this.#executionInvalidationController.queueWorkflowInvalidation(client, hooks, workflowId),
      queueGlobalInvalidation: (client, hooks) => this.#executionInvalidationController.queueGlobalInvalidation(client, hooks),
      deleteBlobKeysBestEffort: (context, keys) => this.#deleteBlobKeysBestEffort(context, keys),
      isUniqueViolation,
      recordingColumns: RECORDING_COLUMNS,
    });
    this.#publication = createManagedWorkflowPublicationService({
      withTransaction: (run) => this.#withTransaction(run),
      getWorkflowByRelativePath: (client, relativePath, options) => this.#getWorkflowByRelativePath(client, relativePath, options),
      syncWorkflowEndpointRows: (client, workflow, endpoints) => this.#syncWorkflowEndpointRows(client, workflow, endpoints),
      mapWorkflowRowToProjectItem,
      queueWorkflowInvalidation: (client, hooks, workflowId) => this.#executionInvalidationController.queueWorkflowInvalidation(client, hooks, workflowId),
    });
    this.#recordings = createManagedWorkflowRecordingService({
      pool: this.#pool,
      initialize: () => this.initialize(),
      withTransaction: (run) => this.#withTransaction(run),
      uploadRecordingBlobs: (workflowId, recordingId, artifacts, cleanupContext) => this.#uploadRecordingBlobs(workflowId, recordingId, artifacts, cleanupContext),
      insertRecordingRow: (client, row, options) => this.#insertRecordingRow(client, row, options),
      queryOne: (client, sql, params) => queryOne(client, sql, params),
      queryRows: (client, sql, params) => queryRows(client, sql, params),
      blobStore: this.#blobStore,
      deleteBlobKeysBestEffort: (context, keys) => this.#deleteBlobKeysBestEffort(context, keys),
      getWorkflowStatus,
      mapWorkflowRowToProjectItem,
      toIsoString,
      workflowColumnsQualified: WORKFLOW_COLUMNS_QUALIFIED,
      recordingColumns: RECORDING_COLUMNS,
    });
  }

  async initialize(): Promise<void> {
    if (!this.#schemaReadyPromise) {
      this.#schemaReadyPromise = (async () => {
        await this.#blobStore.initialize?.();
        await withManagedDbRetry('managed schema initialization', () => this.#pool.query(MANAGED_WORKFLOW_SCHEMA_SQL));
      })().catch((error) => {
        this.#schemaReadyPromise = null;
        throw error;
      });
    }

    await this.#schemaReadyPromise;
    await this.#executionInvalidationController.initialize();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#executionInvalidationController.dispose();
    this.#executionCache.clearRevisionMaterializations();
    await this.#pool.end();
  }

  async #deleteBlobKeys(keys: Array<string | null | undefined>): Promise<void> {
    await Promise.all(keys.map((key) => this.#blobStore.delete(key)));
  }

  async #deleteBlobKeysBestEffort(context: string, keys: Array<string | null | undefined>): Promise<void> {
    const deletions = await Promise.allSettled([this.#deleteBlobKeys(keys)]);
    const rejected = deletions.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      console.error(`[managed-workflows] Failed to clean up blob objects after ${context}:`, rejected.reason);
    }
  }

  #scheduleRevisionBlobCleanup(
    hooks: TransactionHooks,
    revision: Pick<RevisionRow, 'project_blob_key' | 'dataset_blob_key'>,
  ): void {
    hooks.onRollback(() => this.#deleteBlobKeysBestEffort('transaction rollback', [
      revision.project_blob_key,
      revision.dataset_blob_key,
    ]));
  }

  async #connectWithRetry(): Promise<PoolClient> {
    return withManagedDbRetry('database connect', () => this.#pool.connect());
  }

  async #withTransaction<T>(run: (client: PoolClient, hooks: TransactionHooks) => Promise<T>): Promise<T> {
    await this.initialize();
    const client = await this.#connectWithRetry();
    const onCommitTasks: Array<() => Promise<void>> = [];
    const onRollbackTasks: Array<() => Promise<void>> = [];
    const hooks: TransactionHooks = {
      onCommit(task) {
        onCommitTasks.push(task);
      },
      onRollback(task) {
        onRollbackTasks.push(task);
      },
    };

    try {
      await client.query('BEGIN');
      const result = await run(client, hooks);
      await client.query('COMMIT');

      for (const task of onCommitTasks) {
        try {
          await task();
        } catch (error) {
          console.error('[managed-workflows] Post-commit cleanup failed:', error);
        }
      }

      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});

      for (const task of onRollbackTasks) {
        try {
          await task();
        } catch (cleanupError) {
          console.error('[managed-workflows] Rollback cleanup failed:', cleanupError);
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  async #listFolderRows(client: PoolClient | Pool = this.#pool): Promise<FolderRow[]> {
    return queryRows<FolderRow>(client, 'SELECT relative_path, name, parent_relative_path, updated_at FROM workflow_folders ORDER BY relative_path ASC');
  }

  async #listWorkflowRows(client: PoolClient | Pool = this.#pool): Promise<WorkflowRow[]> {
    return queryRows<WorkflowRow>(client, `
      SELECT ${WORKFLOW_COLUMNS}
      FROM workflows
      ORDER BY relative_path ASC
    `);
  }

  async #getWorkflowByRelativePath(client: PoolClient | Pool, relativePath: string, options: { forUpdate?: boolean } = {}): Promise<WorkflowRow | null> {
    return queryOne<WorkflowRow>(
      client,
      `
        SELECT ${WORKFLOW_COLUMNS}
        FROM workflows
        WHERE relative_path = $1
        ${options.forUpdate ? 'FOR UPDATE' : ''}
      `,
      [relativePath],
    );
  }

  async #getWorkflowById(client: PoolClient | Pool, workflowId: string): Promise<WorkflowRow | null> {
    return queryOne<WorkflowRow>(
      client,
      `
        SELECT ${WORKFLOW_COLUMNS}
        FROM workflows
        WHERE workflow_id = $1
      `,
      [workflowId],
    );
  }

  async #getRevision(client: PoolClient | Pool, revisionId: string | null | undefined): Promise<RevisionRow | null> {
    if (!revisionId) {
      return null;
    }

    return queryOne<RevisionRow>(
      client,
      `
        SELECT revision_id, workflow_id, project_blob_key, dataset_blob_key, created_at
        FROM workflow_revisions
        WHERE revision_id = $1
      `,
      [revisionId],
    );
  }

  async #getCurrentDraftWorkflowRevision(
    client: PoolClient | Pool,
    relativePath: string,
  ): Promise<{ workflow: WorkflowRow; revision: RevisionRow } | null> {
    const row = await queryOne<CurrentDraftRevisionRow>(
      client,
      `
        SELECT
          w.workflow_id,
          w.name,
          w.file_name,
          w.relative_path,
          w.folder_relative_path,
          w.updated_at,
          w.current_draft_revision_id,
          w.published_revision_id,
          w.endpoint_name,
          w.published_endpoint_name,
          w.last_published_at,
          r.revision_id,
          r.workflow_id AS revision_workflow_id,
          r.project_blob_key,
          r.dataset_blob_key,
          r.created_at AS revision_created_at
        FROM workflows w
        JOIN workflow_revisions r ON r.revision_id = w.current_draft_revision_id
        WHERE w.relative_path = $1
      `,
      [relativePath],
    );

    return row ? splitCurrentDraftRevisionRow(row) : null;
  }

  async #getEndpointOwner(client: PoolClient | Pool, lookupName: string): Promise<{ workflow_id: string } | null> {
    return queryOne<{ workflow_id: string }>(
      client,
      'SELECT workflow_id FROM workflow_endpoints WHERE lookup_name = $1',
      [lookupName],
    );
  }

  async #ensureFolderChain(client: PoolClient, folderRelativePath: string): Promise<void> {
    if (!folderRelativePath) {
      return;
    }

    const segments = folderRelativePath.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const relativePath = segments.slice(0, index + 1).join('/');
      const parentRelativePath = segments.slice(0, index).join('/');
      await client.query(
        `
          INSERT INTO workflow_folders (relative_path, name, parent_relative_path, updated_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (relative_path) DO UPDATE SET
            name = EXCLUDED.name,
            parent_relative_path = EXCLUDED.parent_relative_path
        `,
        [relativePath, segments[index], parentRelativePath],
      );
    }
  }

  async #assertFolderExists(client: PoolClient | Pool, folderRelativePath: string): Promise<void> {
    if (!folderRelativePath) {
      return;
    }

    const row = await queryOne<{ relative_path: string }>(
      client,
      'SELECT relative_path FROM workflow_folders WHERE relative_path = $1',
      [folderRelativePath],
    );
    if (!row) {
      throw createHttpError(404, 'Folder not found');
    }
  }

  async #readRevisionContents(revision: RevisionRow): Promise<{ contents: string; datasetsContents: string | null }> {
    const [contents, datasetsContents] = await Promise.all([
      this.#blobStore.getText(revision.project_blob_key),
      revision.dataset_blob_key ? this.#blobStore.getText(revision.dataset_blob_key) : Promise.resolve(null),
    ]);

    return {
      contents,
      datasetsContents,
    };
  }

  async #createRevision(workflowId: string, contents: string, datasetsContents: string | null): Promise<RevisionRow> {
    const revisionId = createManagedRevisionId();
    const projectBlobKey = createRevisionBlobKey(workflowId, revisionId, 'project');
    const datasetBlobKey = datasetsContents != null
      ? createRevisionBlobKey(workflowId, revisionId, 'dataset')
      : null;

    await this.#blobStore.putText(projectBlobKey, contents, 'application/x-yaml; charset=utf-8');
    try {
      if (datasetBlobKey && datasetsContents != null) {
        await this.#blobStore.putText(datasetBlobKey, datasetsContents, 'text/plain; charset=utf-8');
      }
    } catch (error) {
      await this.#deleteBlobKeysBestEffort('revision upload rollback', [projectBlobKey, datasetBlobKey]);
      throw error;
    }

    return {
      revision_id: revisionId,
      workflow_id: workflowId,
      project_blob_key: projectBlobKey,
      dataset_blob_key: datasetBlobKey,
      created_at: new Date(),
    };
  }

  async #insertRevision(client: PoolClient, revision: RevisionRow): Promise<void> {
    await client.query(
      `
        INSERT INTO workflow_revisions (revision_id, workflow_id, project_blob_key, dataset_blob_key, created_at)
        VALUES ($1, $2, $3, $4, NOW())
      `,
      [revision.revision_id, revision.workflow_id, revision.project_blob_key, revision.dataset_blob_key],
    );
  }

  async #uploadRecordingBlobs(
    workflowId: string,
    recordingId: string,
    artifacts: RecordingBlobArtifacts,
    cleanupContext: string,
  ): Promise<RecordingBlobKeys> {
    const recordingBlobKey = createRecordingBlobKey(workflowId, recordingId, 'recording');
    const replayProjectBlobKey = createRecordingBlobKey(workflowId, recordingId, 'replay-project');
    const replayDatasetBlobKey = artifacts.replayDataset != null
      ? createRecordingBlobKey(workflowId, recordingId, 'replay-dataset')
      : null;

    try {
      await Promise.all([
        this.#blobStore.putText(recordingBlobKey, artifacts.recording, 'text/plain; charset=utf-8'),
        this.#blobStore.putText(replayProjectBlobKey, artifacts.replayProject, 'application/x-yaml; charset=utf-8'),
        replayDatasetBlobKey != null && artifacts.replayDataset != null
          ? this.#blobStore.putText(replayDatasetBlobKey, artifacts.replayDataset, 'text/plain; charset=utf-8')
          : Promise.resolve(),
      ]);
    } catch (error) {
      await this.#deleteBlobKeysBestEffort(cleanupContext, [
        recordingBlobKey,
        replayProjectBlobKey,
        replayDatasetBlobKey,
      ]);
      throw error;
    }

    return {
      recordingBlobKey,
      replayProjectBlobKey,
      replayDatasetBlobKey,
    };
  }

  async #insertRecordingRow(
    client: PoolClient | Pool,
    row: RecordingInsertRowData,
    options: {
      timestampMode: 'provided' | 'now';
      createdAt?: string;
      onConflict: 'ignore' | 'fail';
      cleanupContext: string;
    },
  ): Promise<void> {
    const valuesClause = options.timestampMode === 'provided'
      ? 'VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)'
      : 'VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)';
    const params = options.timestampMode === 'provided'
      ? [
        row.recordingId,
        row.workflowId,
        row.sourceProjectName,
        row.sourceProjectRelativePath,
        options.createdAt,
        row.runKind,
        row.status,
        row.durationMs,
        row.endpointNameAtExecution,
        row.errorMessage,
        row.recordingBlobKey,
        row.replayProjectBlobKey,
        row.replayDatasetBlobKey,
        row.hasReplayDataset,
        row.recordingCompressedBytes,
        row.recordingUncompressedBytes,
        row.projectCompressedBytes,
        row.projectUncompressedBytes,
        row.datasetCompressedBytes,
        row.datasetUncompressedBytes,
      ]
      : [
        row.recordingId,
        row.workflowId,
        row.sourceProjectName,
        row.sourceProjectRelativePath,
        row.runKind,
        row.status,
        row.durationMs,
        row.endpointNameAtExecution,
        row.errorMessage,
        row.recordingBlobKey,
        row.replayProjectBlobKey,
        row.replayDatasetBlobKey,
        row.hasReplayDataset,
        row.recordingCompressedBytes,
        row.recordingUncompressedBytes,
        row.projectCompressedBytes,
        row.projectUncompressedBytes,
        row.datasetCompressedBytes,
        row.datasetUncompressedBytes,
      ];
    const sql = `
      INSERT INTO workflow_recordings (${RECORDING_COLUMNS})
      ${valuesClause}
      ${options.onConflict === 'ignore' ? 'ON CONFLICT (recording_id) DO NOTHING' : ''}
    `;

    try {
      if (client instanceof Pool) {
        await withManagedDbRetry('recording insert', () => client.query(sql, params));
      } else {
        await client.query(sql, params);
      }
    } catch (error) {
      await this.#deleteBlobKeysBestEffort(options.cleanupContext, [
        row.recordingBlobKey,
        row.replayProjectBlobKey,
        row.replayDatasetBlobKey,
      ]);
      throw error;
    }
  }

  async #syncWorkflowEndpointRows(
    client: PoolClient,
    workflow: WorkflowRow,
    endpoints: {
      draftEndpointName: string;
      publishedEndpointName: string;
    },
  ): Promise<void> {
    const desired = new Map<string, { endpointName: string; isDraft: boolean; isPublished: boolean }>();
    const register = (endpointName: string, kind: 'draft' | 'published') => {
      if (!endpointName) {
        return;
      }

      const lookupName = normalizeWorkflowEndpointLookupName(endpointName);
      const existing = desired.get(lookupName);
      if (existing) {
        desired.set(lookupName, {
          endpointName,
          isDraft: existing.isDraft || kind === 'draft',
          isPublished: existing.isPublished || kind === 'published',
        });
        return;
      }

      desired.set(lookupName, {
        endpointName,
        isDraft: kind === 'draft',
        isPublished: kind === 'published',
      });
    };

    register(endpoints.draftEndpointName, 'draft');
    register(endpoints.publishedEndpointName, 'published');

    const existingRows = await queryRows<{ lookup_name: string }>(
      client,
      'SELECT lookup_name FROM workflow_endpoints WHERE workflow_id = $1',
      [workflow.workflow_id],
    );

    for (const [lookupName, endpointRow] of desired) {
      const owner = await this.#getEndpointOwner(client, lookupName);
      if (owner && owner.workflow_id !== workflow.workflow_id) {
        throw conflict('Endpoint name is already used by another workflow');
      }

      await client.query(
        `
          INSERT INTO workflow_endpoints (lookup_name, workflow_id, endpoint_name, is_draft, is_published, updated_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (lookup_name) DO UPDATE SET
            workflow_id = EXCLUDED.workflow_id,
            endpoint_name = EXCLUDED.endpoint_name,
            is_draft = EXCLUDED.is_draft,
            is_published = EXCLUDED.is_published,
            updated_at = NOW()
        `,
        [lookupName, workflow.workflow_id, endpointRow.endpointName, endpointRow.isDraft, endpointRow.isPublished],
      );
    }

    const desiredLookupNames = [...desired.keys()];
    if (desiredLookupNames.length === 0) {
      await client.query('DELETE FROM workflow_endpoints WHERE workflow_id = $1', [workflow.workflow_id]);
      return;
    }

    await client.query(
      'DELETE FROM workflow_endpoints WHERE workflow_id = $1 AND lookup_name <> ALL($2::text[])',
      [workflow.workflow_id, desiredLookupNames],
    );

    for (const existingRow of existingRows) {
      if (!desired.has(existingRow.lookup_name)) {
        await client.query('DELETE FROM workflow_endpoints WHERE lookup_name = $1 AND workflow_id = $2', [
          existingRow.lookup_name,
          workflow.workflow_id,
        ]);
      }
    }
  }

  async getTree(): Promise<{ root: string; folders: WorkflowFolderItem[]; projects: WorkflowProjectItem[] }> {
    return this.#catalog.getTree();
  }

  async listProjectPathsForHostedIo(): Promise<string[]> {
    return this.#catalog.listProjectPathsForHostedIo();
  }

  async loadHostedProject(projectPath: string): Promise<LoadHostedProjectResult> {
    return this.#revisions.loadHostedProject(projectPath);
  }

  async saveHostedProject(options: {
    projectPath: string;
    contents: string;
    datasetsContents: string | null;
    expectedRevisionId?: string | null;
  }): Promise<SaveHostedProjectResult> {
    return this.#revisions.saveHostedProject(options);
  }

  async importWorkflow(options: ImportManagedWorkflowOptions): Promise<WorkflowProjectItem> {
    return this.#revisions.importWorkflow(options);
  }

  async readHostedText(filePath: string): Promise<string> {
    return this.#catalog.readHostedText(filePath);
  }

  async hostedPathExists(filePath: string): Promise<boolean> {
    return this.#catalog.hostedPathExists(filePath);
  }

  async resolveManagedRelativeProjectText(relativeFrom: string, projectFilePath: string): Promise<string> {
    return this.#catalog.resolveManagedRelativeProjectText(relativeFrom, projectFilePath);
  }

  async createWorkflowFolderItem(name: unknown, parentRelativePath: unknown) {
    return this.#catalog.createWorkflowFolderItem(name, parentRelativePath);
  }

  async renameWorkflowFolderItem(relativePath: unknown, newName: unknown): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.renameWorkflowFolderItem(relativePath, newName);
  }

  async moveWorkflowFolder(sourceRelativePath: unknown, destinationFolderRelativePath: unknown): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.moveWorkflowFolder(sourceRelativePath, destinationFolderRelativePath);
  }

  async deleteWorkflowFolderItem(relativePath: unknown): Promise<void> {
    return this.#catalog.deleteWorkflowFolderItem(relativePath);
  }

  async createWorkflowProjectItem(folderRelativePath: unknown, name: unknown): Promise<WorkflowProjectItem> {
    return this.#catalog.createWorkflowProjectItem(folderRelativePath, name);
  }

  async renameWorkflowProjectItem(relativePath: unknown, newName: unknown): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.renameWorkflowProjectItem(relativePath, newName);
  }

  async moveWorkflowProject(sourceRelativePath: unknown, destinationFolderRelativePath: unknown): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.moveWorkflowProject(sourceRelativePath, destinationFolderRelativePath);
  }

  async duplicateWorkflowProjectItem(relativePath: unknown, version: WorkflowProjectDownloadVersion = 'live'): Promise<WorkflowProjectItem> {
    return this.#catalog.duplicateWorkflowProjectItem(relativePath, version);
  }

  async uploadWorkflowProjectItem(folderRelativePath: unknown, fileName: unknown, contents: unknown): Promise<WorkflowProjectItem> {
    return this.#catalog.uploadWorkflowProjectItem(folderRelativePath, fileName, contents);
  }

  async readWorkflowProjectDownload(relativePath: unknown, version: WorkflowProjectDownloadVersion): Promise<{ contents: string; fileName: string }> {
    return this.#catalog.readWorkflowProjectDownload(relativePath, version);
  }

  async publishWorkflowProjectItem(relativePath: unknown, settings: unknown): Promise<WorkflowProjectItem> {
    return this.#publication.publishWorkflowProjectItem(relativePath, settings);
  }

  async unpublishWorkflowProjectItem(relativePath: unknown): Promise<WorkflowProjectItem> {
    return this.#publication.unpublishWorkflowProjectItem(relativePath);
  }

  async deleteWorkflowProjectItem(relativePath: unknown): Promise<void> {
    return this.#catalog.deleteWorkflowProjectItem(relativePath);
  }

  async loadPublishedExecutionProject(endpointName: string): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadPublishedExecutionProject(endpointName);
  }

  async loadLatestExecutionProject(endpointName: string): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadLatestExecutionProject(endpointName);
  }

  async #resolveExecutionPointerFromDatabase(
    client: Pool,
    runKind: 'published' | 'latest',
    lookupName: string,
  ): Promise<ManagedExecutionPointerLookupResult | null> {
    const revisionJoinColumn = runKind === 'published'
      ? 'w.published_revision_id'
      : 'w.current_draft_revision_id';
    const row = await queryOne<CurrentDraftRevisionRow>(
      client,
      `
        SELECT
          w.workflow_id,
          w.name,
          w.file_name,
          w.relative_path,
          w.folder_relative_path,
          w.updated_at,
          w.current_draft_revision_id,
          w.published_revision_id,
          w.endpoint_name,
          w.published_endpoint_name,
          w.last_published_at,
          r.revision_id,
          r.workflow_id AS revision_workflow_id,
          r.project_blob_key,
          r.dataset_blob_key,
          r.created_at AS revision_created_at
        FROM workflow_endpoints e
        JOIN workflows w ON w.workflow_id = e.workflow_id
        JOIN workflow_revisions r ON r.revision_id = ${revisionJoinColumn}
        WHERE e.lookup_name = $1 AND e.is_published = TRUE
      `,
      [lookupName],
    );
    if (!row) {
      return null;
    }

    const split = splitCurrentDraftRevisionRow(row);
    return {
      pointer: {
        workflowId: split.workflow.workflow_id,
        relativePath: split.workflow.relative_path,
        revisionId: split.revision.revision_id,
      },
      revision: split.revision,
    };
  }

  createProjectReferenceLoader() {
    return this.#executionService.createProjectReferenceLoader();
  }

  async importWorkflowRecording(options: ImportManagedWorkflowRecordingOptions): Promise<void> {
    return this.#recordings.importWorkflowRecording(options);
  }

  async listWorkflowRecordingWorkflows(): Promise<WorkflowRecordingWorkflowListResponse> {
    return this.#recordings.listWorkflowRecordingWorkflows();
  }

  async listWorkflowRecordingRunsPage(
    workflowId: string,
    page: number,
    pageSize: number,
    statusFilter: WorkflowRecordingFilterStatus,
  ): Promise<WorkflowRecordingRunsPageResponse> {
    return this.#recordings.listWorkflowRecordingRunsPage(workflowId, page, pageSize, statusFilter);
  }

  async readWorkflowRecordingArtifact(recordingId: string, artifact: 'recording' | 'replay-project' | 'replay-dataset'): Promise<string> {
    return this.#recordings.readWorkflowRecordingArtifact(recordingId, artifact);
  }

  async deleteWorkflowRecording(recordingId: string): Promise<void> {
    return this.#recordings.deleteWorkflowRecording(recordingId);
  }

  async persistWorkflowExecutionRecording(options: PersistWorkflowExecutionRecordingOptions): Promise<void> {
    return this.#recordings.persistWorkflowExecutionRecording(options);
  }
}
