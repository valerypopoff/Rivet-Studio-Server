import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  NodeDatasetProvider,
  deserializeDatasets,
  loadProjectAndAttachedDataFromString,
  loadProjectFromString,
  serializeDatasets,
  serializeProject,
  type AttachedData,
  type CombinedDataset,
  type Project,
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
import { WORKFLOW_PROJECT_EXTENSION } from '../../../../../shared/workflow-types.js';
import { badRequest, conflict, createHttpError } from '../../../utils/httpError.js';
import { createBlankProjectFile, sanitizeWorkflowName } from '../fs-helpers.js';
import { normalizeStoredEndpointName, normalizeWorkflowEndpointLookupName } from '../publication.js';
import { getWorkflowDownloadFileName, getWorkflowDuplicateProjectName } from '../workflow-project-naming.js';
import type { ManagedWorkflowStorageConfig } from '../storage-config.js';
import {
  getManagedWorkflowFolderVirtualPath,
  getManagedWorkflowProjectVirtualPath,
  getManagedWorkflowVirtualRoot,
  getProjectRelativePathFromDatasetVirtualPath,
  isManagedWorkflowDatasetVirtualPath,
  normalizeManagedWorkflowRelativePath,
  parseManagedWorkflowProjectVirtualPath,
  resolveManagedWorkflowRelativeReference,
} from '../virtual-paths.js';
import {
  S3ManagedWorkflowBlobStore,
  createManagedRevisionId,
  createRecordingBlobKey,
  createRevisionBlobKey,
  type ManagedWorkflowBlobStore,
} from './blob-store.js';

type FolderRow = {
  relative_path: string;
  name: string;
  parent_relative_path: string;
  updated_at: Date | string;
};

type WorkflowRow = {
  workflow_id: string;
  name: string;
  file_name: string;
  relative_path: string;
  folder_relative_path: string;
  updated_at: Date | string;
  current_draft_revision_id: string;
  published_revision_id: string | null;
  endpoint_name: string;
  published_endpoint_name: string;
  last_published_at: Date | string | null;
};

type RevisionRow = {
  revision_id: string;
  workflow_id: string;
  project_blob_key: string;
  dataset_blob_key: string | null;
  created_at: Date | string;
};

type CurrentDraftRevisionRow = {
  workflow_id: string;
  name: string;
  file_name: string;
  relative_path: string;
  folder_relative_path: string;
  updated_at: Date | string;
  current_draft_revision_id: string;
  published_revision_id: string | null;
  endpoint_name: string;
  published_endpoint_name: string;
  last_published_at: Date | string | null;
  revision_id: string;
  revision_workflow_id: string;
  project_blob_key: string;
  dataset_blob_key: string | null;
  revision_created_at: Date | string;
};

type ManagedRevisionContents = {
  contents: string;
  datasetsContents: string | null;
};

type FolderMoveRow = {
  relative_path: string;
  name: string;
  parent_relative_path: string;
  updated_at: Date | string;
  moved_relative_paths: string[] | null;
};

type RecordingRow = {
  recording_id: string;
  workflow_id: string;
  source_project_name: string;
  source_project_relative_path: string;
  created_at: Date | string;
  run_kind: 'published' | 'latest';
  status: 'succeeded' | 'failed' | 'suspicious';
  duration_ms: number;
  endpoint_name_at_execution: string;
  error_message: string | null;
  recording_blob_key: string;
  replay_project_blob_key: string;
  replay_dataset_blob_key: string | null;
  has_replay_dataset: boolean;
  recording_compressed_bytes: number;
  recording_uncompressed_bytes: number;
  project_compressed_bytes: number;
  project_uncompressed_bytes: number;
  dataset_compressed_bytes: number;
  dataset_uncompressed_bytes: number;
};

type EndpointAggregateRow = {
  workflow_id: string;
  total_runs: number;
  failed_runs: number;
  suspicious_runs: number;
  latest_run_at: Date | string | null;
};

type WorkflowRecordingListRow = WorkflowRow & Partial<EndpointAggregateRow>;

type SaveHostedProjectResult = {
  path: string;
  revisionId: string;
  project: WorkflowProjectItem;
  created: boolean;
};

type LoadHostedProjectResult = {
  contents: string;
  datasetsContents: string | null;
  revisionId: string;
};

type ExecutionWorkflowMatch = {
  workflow: WorkflowRow;
  revision: RevisionRow;
};

type TransactionHooks = {
  onCommit(task: () => Promise<void>): void;
  onRollback(task: () => Promise<void>): void;
};

type PersistWorkflowExecutionRecordingOptions = {
  sourceProject: Project;
  sourceProjectPath: string;
  executedProject: Project;
  executedAttachedData: AttachedData;
  executedDatasets: CombinedDataset[];
  endpointName: string;
  recordingSerialized: string;
  runKind: 'published' | 'latest';
  status: 'succeeded' | 'failed' | 'suspicious';
  durationMs: number;
  errorMessage?: string;
};

type ImportManagedWorkflowOptions = {
  workflowId: string;
  relativePath: string;
  name: string;
  fileName?: string;
  contents: string;
  datasetsContents: string | null;
  endpointName: string;
  publishedEndpointName: string;
  publishedContents?: string | null;
  publishedDatasetsContents?: string | null;
  lastPublishedAt?: string | null;
  updatedAt?: string | null;
};

type ImportManagedWorkflowRecordingOptions = {
  recordingId: string;
  workflowId: string;
  sourceProjectRelativePath: string;
  sourceProjectName: string;
  createdAt: string;
  runKind: 'published' | 'latest';
  status: 'succeeded' | 'failed' | 'suspicious';
  durationMs: number;
  endpointName: string;
  errorMessage?: string;
  recordingContents: string;
  replayProjectContents: string;
  replayDatasetContents?: string | null;
};

const MANAGED_WORKFLOW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflow_folders (
  relative_path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_relative_path TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  folder_relative_path TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_draft_revision_id TEXT NOT NULL,
  published_revision_id TEXT NULL,
  endpoint_name TEXT NOT NULL DEFAULT '',
  published_endpoint_name TEXT NOT NULL DEFAULT '',
  last_published_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS workflow_revisions (
  revision_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  project_blob_key TEXT NOT NULL,
  dataset_blob_key TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_endpoints (
  lookup_name TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  endpoint_name TEXT NOT NULL,
  is_draft BOOLEAN NOT NULL DEFAULT FALSE,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_endpoints_workflow_id_idx ON workflow_endpoints(workflow_id);
CREATE INDEX IF NOT EXISTS workflows_folder_relative_path_idx ON workflows(folder_relative_path);
CREATE INDEX IF NOT EXISTS workflow_revisions_workflow_id_idx ON workflow_revisions(workflow_id);
CREATE INDEX IF NOT EXISTS workflow_folders_relative_path_prefix_idx ON workflow_folders(relative_path text_pattern_ops);
CREATE INDEX IF NOT EXISTS workflow_folders_parent_relative_path_idx ON workflow_folders(parent_relative_path);
CREATE INDEX IF NOT EXISTS workflow_folders_parent_relative_path_prefix_idx ON workflow_folders(parent_relative_path text_pattern_ops);
CREATE INDEX IF NOT EXISTS workflows_relative_path_prefix_idx ON workflows(relative_path text_pattern_ops);
CREATE INDEX IF NOT EXISTS workflows_folder_relative_path_prefix_idx ON workflows(folder_relative_path text_pattern_ops);

DROP FUNCTION IF EXISTS move_managed_workflow_folder(TEXT, TEXT, TEXT, TEXT);

CREATE FUNCTION move_managed_workflow_folder(
  source_relative_path TEXT,
  temporary_prefix TEXT,
  target_relative_path TEXT,
  folder_name TEXT
) RETURNS TABLE (
  relative_path TEXT,
  name TEXT,
  parent_relative_path TEXT,
  updated_at TIMESTAMPTZ,
  moved_relative_paths TEXT[]
) LANGUAGE plpgsql AS $$
DECLARE
  target_parent_relative_path TEXT := CASE
    WHEN position('/' in target_relative_path) = 0 THEN ''
    ELSE regexp_replace(target_relative_path, '/[^/]+$', '')
  END;
  source_prefix_pattern TEXT := replace(replace(replace(source_relative_path, '\', '\\'), '%', '\%'), '_', '\_') || '/%';
  temporary_prefix_pattern TEXT := replace(replace(replace(temporary_prefix, '\', '\\'), '%', '\%'), '_', '\_') || '/%';
  moved_paths TEXT[] := ARRAY[]::TEXT[];
BEGIN
  PERFORM 1
  FROM workflow_folders AS folder
  WHERE folder.relative_path = source_relative_path
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
  FROM workflow_folders AS folder
  WHERE folder.relative_path = source_relative_path OR folder.relative_path LIKE source_prefix_pattern ESCAPE '\'
  FOR UPDATE;

  IF target_parent_relative_path <> '' THEN
    PERFORM 1
    FROM workflow_folders AS folder
    WHERE folder.relative_path = target_parent_relative_path
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM workflow_folders AS folder
    WHERE folder.relative_path = target_relative_path
  ) THEN
    RAISE EXCEPTION 'Folder already exists: %', folder_name USING ERRCODE = '23505';
  END IF;

  WITH locked_workflows AS (
    SELECT workflow.relative_path
    FROM workflows AS workflow
    WHERE workflow.relative_path = source_relative_path OR workflow.relative_path LIKE source_prefix_pattern ESCAPE '\'
    ORDER BY workflow.relative_path ASC
    FOR UPDATE
  )
  SELECT COALESCE(array_agg(locked_workflows.relative_path ORDER BY locked_workflows.relative_path ASC), ARRAY[]::TEXT[])
  INTO moved_paths
  FROM locked_workflows;

  UPDATE workflow_folders AS folder
  SET relative_path = CASE
        WHEN folder.relative_path = source_relative_path THEN temporary_prefix
        ELSE temporary_prefix || substring(folder.relative_path from char_length(source_relative_path) + 1)
      END,
      parent_relative_path = CASE
        WHEN folder.parent_relative_path = source_relative_path THEN temporary_prefix
        WHEN folder.parent_relative_path LIKE source_prefix_pattern ESCAPE '\' THEN temporary_prefix || substring(folder.parent_relative_path from char_length(source_relative_path) + 1)
        ELSE folder.parent_relative_path
      END,
      updated_at = NOW()
  WHERE folder.relative_path = source_relative_path OR folder.relative_path LIKE source_prefix_pattern ESCAPE '\';

  UPDATE workflows AS workflow
  SET relative_path = CASE
        WHEN workflow.relative_path = source_relative_path THEN temporary_prefix
        ELSE temporary_prefix || substring(workflow.relative_path from char_length(source_relative_path) + 1)
      END,
      folder_relative_path = CASE
        WHEN workflow.folder_relative_path = source_relative_path THEN temporary_prefix
        WHEN workflow.folder_relative_path LIKE source_prefix_pattern ESCAPE '\' THEN temporary_prefix || substring(workflow.folder_relative_path from char_length(source_relative_path) + 1)
        ELSE workflow.folder_relative_path
      END,
      updated_at = NOW()
  WHERE workflow.relative_path = source_relative_path OR workflow.relative_path LIKE source_prefix_pattern ESCAPE '\';

  UPDATE workflow_folders AS folder
  SET relative_path = CASE
        WHEN folder.relative_path = temporary_prefix THEN target_relative_path
        ELSE target_relative_path || substring(folder.relative_path from char_length(temporary_prefix) + 1)
      END,
      name = CASE
        WHEN folder.relative_path = temporary_prefix THEN folder_name
        ELSE folder.name
      END,
      parent_relative_path = CASE
        WHEN folder.parent_relative_path = temporary_prefix THEN target_relative_path
        WHEN folder.parent_relative_path LIKE temporary_prefix_pattern ESCAPE '\' THEN target_relative_path || substring(folder.parent_relative_path from char_length(temporary_prefix) + 1)
        ELSE folder.parent_relative_path
      END,
      updated_at = NOW()
  WHERE folder.relative_path = temporary_prefix OR folder.relative_path LIKE temporary_prefix_pattern ESCAPE '\';

  UPDATE workflows AS workflow
  SET relative_path = CASE
        WHEN workflow.relative_path = temporary_prefix THEN target_relative_path
        ELSE target_relative_path || substring(workflow.relative_path from char_length(temporary_prefix) + 1)
      END,
      folder_relative_path = CASE
        WHEN workflow.folder_relative_path = temporary_prefix THEN target_relative_path
        WHEN workflow.folder_relative_path LIKE temporary_prefix_pattern ESCAPE '\' THEN target_relative_path || substring(workflow.folder_relative_path from char_length(temporary_prefix) + 1)
        ELSE workflow.folder_relative_path
      END,
      updated_at = NOW()
  WHERE workflow.relative_path = temporary_prefix OR workflow.relative_path LIKE temporary_prefix_pattern ESCAPE '\';

  RETURN QUERY
    SELECT workflow_folders.relative_path, workflow_folders.name, workflow_folders.parent_relative_path, workflow_folders.updated_at, moved_paths
    FROM workflow_folders
    WHERE workflow_folders.relative_path = target_relative_path;
END;
$$;

CREATE TABLE IF NOT EXISTS workflow_recordings (
  recording_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  source_project_name TEXT NOT NULL,
  source_project_relative_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  endpoint_name_at_execution TEXT NOT NULL,
  error_message TEXT NULL,
  recording_blob_key TEXT NOT NULL,
  replay_project_blob_key TEXT NOT NULL,
  replay_dataset_blob_key TEXT NULL,
  has_replay_dataset BOOLEAN NOT NULL DEFAULT FALSE,
  recording_compressed_bytes INTEGER NOT NULL DEFAULT 0,
  recording_uncompressed_bytes INTEGER NOT NULL DEFAULT 0,
  project_compressed_bytes INTEGER NOT NULL DEFAULT 0,
  project_uncompressed_bytes INTEGER NOT NULL DEFAULT 0,
  dataset_compressed_bytes INTEGER NOT NULL DEFAULT 0,
  dataset_uncompressed_bytes INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS workflow_recordings_workflow_id_idx ON workflow_recordings(workflow_id);
CREATE INDEX IF NOT EXISTS workflow_recordings_created_at_idx ON workflow_recordings(created_at DESC);
`;

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

function getPoolConfig(config: ManagedWorkflowStorageConfig) {
  const sharedConfig = {
    connectionString: config.databaseUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    idleTimeoutMillis: 30_000,
    max: 10,
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
  #schemaReadyPromise: Promise<void> | null = null;

  constructor(config: ManagedWorkflowStorageConfig, blobStore?: ManagedWorkflowBlobStore) {
    this.#pool = new Pool(getPoolConfig(config));
    this.#blobStore = blobStore ?? new S3ManagedWorkflowBlobStore(config);
  }

  async initialize(): Promise<void> {
    if (!this.#schemaReadyPromise) {
      this.#schemaReadyPromise = (async () => {
        await this.#blobStore.initialize?.();
        await withManagedDbRetry('managed schema initialization', () => this.#pool.query(MANAGED_WORKFLOW_SCHEMA_SQL));
      })();
    }

    await this.#schemaReadyPromise;
  }

  async dispose(): Promise<void> {
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
      SELECT workflow_id, name, file_name, relative_path, folder_relative_path, updated_at,
             current_draft_revision_id, published_revision_id, endpoint_name, published_endpoint_name, last_published_at
      FROM workflows
      ORDER BY relative_path ASC
    `);
  }

  async #getWorkflowByRelativePath(client: PoolClient | Pool, relativePath: string, options: { forUpdate?: boolean } = {}): Promise<WorkflowRow | null> {
    return queryOne<WorkflowRow>(
      client,
      `
        SELECT workflow_id, name, file_name, relative_path, folder_relative_path, updated_at,
               current_draft_revision_id, published_revision_id, endpoint_name, published_endpoint_name, last_published_at
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
        SELECT workflow_id, name, file_name, relative_path, folder_relative_path, updated_at,
               current_draft_revision_id, published_revision_id, endpoint_name, published_endpoint_name, last_published_at
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
    await this.initialize();
    const [folderRows, workflowRows] = await Promise.all([
      this.#listFolderRows(),
      this.#listWorkflowRows(),
    ]);

    const folderMap = new Map<string, WorkflowFolderItem>();
    for (const row of folderRows) {
      folderMap.set(row.relative_path, mapFolderRowToFolderItem(row));
    }

    const rootFolders: WorkflowFolderItem[] = [];
    const rootProjects: WorkflowProjectItem[] = [];

    for (const row of folderRows) {
      const folder = folderMap.get(row.relative_path)!;
      const parent = row.parent_relative_path ? folderMap.get(row.parent_relative_path) : null;
      if (parent) {
        parent.folders.push(folder);
      } else {
        rootFolders.push(folder);
      }
    }

    for (const row of workflowRows) {
      const project = mapWorkflowRowToProjectItem(row);
      const parent = row.folder_relative_path ? folderMap.get(row.folder_relative_path) : null;
      if (parent) {
        parent.projects.push(project);
      } else {
        rootProjects.push(project);
      }
    }

    const sortFolder = (folder: WorkflowFolderItem) => {
      folder.folders.sort((left, right) => left.name.localeCompare(right.name));
      folder.projects.sort((left, right) => left.name.localeCompare(right.name));
      for (const childFolder of folder.folders) {
        sortFolder(childFolder);
      }
    };

    rootFolders.sort((left, right) => left.name.localeCompare(right.name));
    rootProjects.sort((left, right) => left.name.localeCompare(right.name));
    for (const folder of rootFolders) {
      sortFolder(folder);
    }

    return {
      root: getManagedWorkflowVirtualRoot(),
      folders: rootFolders,
      projects: rootProjects,
    };
  }

  async listProjectPathsForHostedIo(): Promise<string[]> {
    await this.initialize();
    const workflows = await this.#listWorkflowRows();
    return workflows.map((workflow) => getManagedWorkflowProjectVirtualPath(workflow.relative_path));
  }

  async loadHostedProject(projectPath: string): Promise<LoadHostedProjectResult> {
    await this.initialize();
    const relativePath = parseManagedWorkflowProjectVirtualPath(projectPath);
    const loaded = await this.#getCurrentDraftWorkflowRevision(this.#pool, relativePath);
    if (!loaded) {
      throw createHttpError(404, 'Project revision not found');
    }

    const contents = await this.#readRevisionContents(loaded.revision);
    return {
      ...contents,
      revisionId: loaded.revision.revision_id,
    };
  }

  async saveHostedProject(options: {
    projectPath: string;
    contents: string;
    datasetsContents: string | null;
    expectedRevisionId?: string | null;
  }): Promise<SaveHostedProjectResult> {
    const relativePath = parseManagedWorkflowProjectVirtualPath(options.projectPath);
    const projectName = path.posix.basename(relativePath, WORKFLOW_PROJECT_EXTENSION);
    const folderRelativePath = path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath);
    const [sourceProject, attachedData] = loadProjectAndAttachedDataFromString(options.contents);

    return this.#withTransaction(async (client, hooks) => {
      await this.#ensureFolderChain(client, folderRelativePath);

      let workflow = await this.#getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
      let contents = options.contents;
      let created = false;
      let workflowId = sourceProject.metadata.id ?? (randomUUID() as typeof sourceProject.metadata.id);

      if (workflow) {
        workflowId = workflow.workflow_id as typeof sourceProject.metadata.id;
        if (options.expectedRevisionId && options.expectedRevisionId !== workflow.current_draft_revision_id) {
          throw conflict('Project has changed since it was opened. Reload it before saving again.');
        }

        if (sourceProject.metadata.id !== workflowId) {
          sourceProject.metadata.id = workflowId as typeof sourceProject.metadata.id;
          const rewritten = serializeProject(sourceProject, attachedData);
          if (typeof rewritten !== 'string') {
            throw createHttpError(400, 'Could not save project');
          }
          contents = rewritten;
        }

        const currentDraftRevision = await this.#getRevision(client, workflow.current_draft_revision_id);
        if (!currentDraftRevision) {
          throw createHttpError(500, 'Current workflow revision could not be loaded');
        }

        const currentDraftContents = await this.#readRevisionContents(currentDraftRevision);
        let publishedContents: ManagedRevisionContents | null = null;

        if (workflow.published_revision_id) {
          if (workflow.published_revision_id === currentDraftRevision.revision_id) {
            publishedContents = currentDraftContents;
          } else {
            const publishedRevision = await this.#getRevision(client, workflow.published_revision_id);
            if (!publishedRevision) {
              throw createHttpError(500, 'Published workflow revision could not be loaded');
            }

            publishedContents = await this.#readRevisionContents(publishedRevision);
          }
        }

        const saveTarget = resolveManagedHostedProjectSaveTarget({
          nextContents: {
            contents,
            datasetsContents: options.datasetsContents,
          },
          currentDraftContents,
          publishedContents,
          draftEndpointName: workflow.endpoint_name,
          publishedEndpointName: workflow.published_endpoint_name,
        });

        if (saveTarget === 'current-draft') {
          return {
            path: getManagedWorkflowProjectVirtualPath(workflow.relative_path),
            revisionId: currentDraftRevision.revision_id,
            project: mapWorkflowRowToProjectItem(workflow),
            created,
          };
        }

        if (saveTarget === 'published-revision') {
          const publishedRevisionId = workflow.published_revision_id ?? currentDraftRevision.revision_id;
          if (workflow.current_draft_revision_id !== publishedRevisionId) {
            await client.query(
              `
                UPDATE workflows
                SET current_draft_revision_id = $2
                WHERE workflow_id = $1
              `,
              [workflow.workflow_id, publishedRevisionId],
            );

            workflow = await this.#getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
            if (!workflow) {
              throw createHttpError(500, 'Saved workflow could not be loaded');
            }
          }

          return {
            path: getManagedWorkflowProjectVirtualPath(workflow.relative_path),
            revisionId: publishedRevisionId,
            project: mapWorkflowRowToProjectItem(workflow),
            created,
          };
        }
      } else {
        const existingIdOwner = await this.#getWorkflowById(client, workflowId);
        if (existingIdOwner) {
          sourceProject.metadata.id = randomUUID() as typeof sourceProject.metadata.id;
          workflowId = sourceProject.metadata.id;
          const rewritten = serializeProject(sourceProject, attachedData);
          if (typeof rewritten !== 'string') {
            throw createHttpError(400, 'Could not save project');
          }
          contents = rewritten;
        }

        created = true;
      }

      const revision = await this.#createRevision(workflowId, contents, options.datasetsContents);
      hooks.onRollback(() => this.#deleteBlobKeysBestEffort('transaction rollback', [
        revision.project_blob_key,
        revision.dataset_blob_key,
      ]));

      if (workflow) {
        await this.#insertRevision(client, revision);
        await client.query(
          `
            UPDATE workflows
            SET name = $2,
                file_name = $3,
                folder_relative_path = $4,
                current_draft_revision_id = $5,
                updated_at = NOW()
            WHERE workflow_id = $1
          `,
          [
            workflow.workflow_id,
            projectName,
            `${projectName}${WORKFLOW_PROJECT_EXTENSION}`,
            folderRelativePath,
            revision.revision_id,
          ],
        );

        workflow = await this.#getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
      } else {
        await client.query(
          `
            INSERT INTO workflows (
              workflow_id, name, file_name, relative_path, folder_relative_path, updated_at,
              current_draft_revision_id, published_revision_id, endpoint_name, published_endpoint_name, last_published_at
            )
            VALUES ($1, $2, $3, $4, $5, NOW(), $6, NULL, '', '', NULL)
          `,
          [
            workflowId,
            projectName,
            `${projectName}${WORKFLOW_PROJECT_EXTENSION}`,
            relativePath,
            folderRelativePath,
            revision.revision_id,
          ],
        );
        await this.#insertRevision(client, revision);

        workflow = await this.#getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
      }

      if (!workflow) {
        throw createHttpError(500, 'Saved workflow could not be loaded');
      }

      return {
        path: getManagedWorkflowProjectVirtualPath(workflow.relative_path),
        revisionId: revision.revision_id,
        project: mapWorkflowRowToProjectItem(workflow),
        created,
      };
    });
  }

  async importWorkflow(options: ImportManagedWorkflowOptions): Promise<WorkflowProjectItem> {
    const relativePath = normalizeManagedWorkflowRelativePath(options.relativePath, { allowProjectFile: true });
    const folderRelativePath = path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath);
    const fileName = options.fileName?.trim() || path.posix.basename(relativePath);
    const workflowName = options.name.trim() || path.posix.basename(relativePath, WORKFLOW_PROJECT_EXTENSION);
    const draftEndpointName = normalizeStoredEndpointName(options.endpointName);
    const publishedEndpointName = normalizeStoredEndpointName(options.publishedEndpointName);
    const updatedAt = options.updatedAt?.trim() || new Date().toISOString();
    const lastPublishedAt = options.lastPublishedAt?.trim() || null;

    return this.#withTransaction(async (client, hooks) => {
      await this.#ensureFolderChain(client, folderRelativePath);

      const existingByPath = await this.#getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
      if (existingByPath) {
        throw conflict(`Managed workflow already exists at ${relativePath}`);
      }

      const existingById = await this.#getWorkflowById(client, options.workflowId);
      if (existingById) {
        throw conflict(`Managed workflow id already exists: ${options.workflowId}`);
      }

      const draftRevision = await this.#createRevision(options.workflowId, options.contents, options.datasetsContents);
      hooks.onRollback(() => this.#deleteBlobKeysBestEffort('transaction rollback', [
        draftRevision.project_blob_key,
        draftRevision.dataset_blob_key,
      ]));

      let publishedRevision: RevisionRow | null = null;
      let publishedRevisionId: string | null = null;
      const shouldCreateSeparatePublishedRevision = publishedEndpointName &&
        (options.publishedContents != null || options.publishedDatasetsContents != null) &&
        (options.publishedContents !== options.contents || options.publishedDatasetsContents !== options.datasetsContents);

      if (publishedEndpointName) {
        if (shouldCreateSeparatePublishedRevision) {
          publishedRevision = await this.#createRevision(
            options.workflowId,
            options.publishedContents ?? options.contents,
            options.publishedDatasetsContents ?? options.datasetsContents,
          );
          hooks.onRollback(() => this.#deleteBlobKeysBestEffort('transaction rollback', [
            publishedRevision!.project_blob_key,
            publishedRevision!.dataset_blob_key,
          ]));
          publishedRevisionId = publishedRevision.revision_id;
        } else {
          publishedRevisionId = draftRevision.revision_id;
        }
      }

      await client.query(
        `
          INSERT INTO workflows (
            workflow_id, name, file_name, relative_path, folder_relative_path, updated_at,
            current_draft_revision_id, published_revision_id, endpoint_name, published_endpoint_name, last_published_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11::timestamptz)
        `,
        [
          options.workflowId,
          workflowName,
          fileName,
          relativePath,
          folderRelativePath,
          updatedAt,
          draftRevision.revision_id,
          publishedRevisionId,
          draftEndpointName,
          publishedEndpointName,
          lastPublishedAt,
        ],
      );
      await this.#insertRevision(client, draftRevision);
      if (publishedRevision) {
        await this.#insertRevision(client, publishedRevision);
      }

      const workflow = await this.#getWorkflowById(client, options.workflowId);
      if (!workflow) {
        throw createHttpError(500, 'Imported workflow could not be loaded');
      }

      await this.#syncWorkflowEndpointRows(client, workflow, {
        draftEndpointName,
        publishedEndpointName,
      });

      return mapWorkflowRowToProjectItem(workflow);
    });
  }

  async readHostedText(filePath: string): Promise<string> {
    if (isManagedWorkflowDatasetVirtualPath(filePath)) {
      const projectRelativePath = getProjectRelativePathFromDatasetVirtualPath(filePath);
      const loaded = await this.#getCurrentDraftWorkflowRevision(this.#pool, projectRelativePath);
      if (!loaded?.revision.dataset_blob_key) {
        throw createHttpError(404, 'Dataset not found');
      }

      return this.#blobStore.getText(loaded.revision.dataset_blob_key);
    }

    const loadedProject = await this.loadHostedProject(filePath);
    return loadedProject.contents;
  }

  async hostedPathExists(filePath: string): Promise<boolean> {
    try {
      if (isManagedWorkflowDatasetVirtualPath(filePath)) {
        const projectRelativePath = getProjectRelativePathFromDatasetVirtualPath(filePath);
        const loaded = await this.#getCurrentDraftWorkflowRevision(this.#pool, projectRelativePath);
        return Boolean(loaded?.revision.dataset_blob_key);
      }

      const relativePath = parseManagedWorkflowProjectVirtualPath(filePath);
      return Boolean(await this.#getCurrentDraftWorkflowRevision(this.#pool, relativePath));
    } catch {
      return false;
    }
  }

  async resolveManagedRelativeProjectText(relativeFrom: string, projectFilePath: string): Promise<string> {
    const resolvedRelativePath = resolveManagedWorkflowRelativeReference(relativeFrom, projectFilePath);
    const loaded = await this.#getCurrentDraftWorkflowRevision(this.#pool, resolvedRelativePath);
    if (!loaded) {
      throw createHttpError(404, 'Project revision not found');
    }

    return this.#blobStore.getText(loaded.revision.project_blob_key);
  }

  async createWorkflowFolderItem(name: unknown, parentRelativePath: unknown) {
    const folderName = sanitizeWorkflowName(name, 'folder name');
    const parentPath = normalizeManagedWorkflowRelativePath(parentRelativePath, { allowProjectFile: false, allowEmpty: true });
    const folderRelativePath = parentPath ? `${parentPath}/${folderName}` : folderName;

    return this.#withTransaction(async (client) => {
      if (await queryOne(client, 'SELECT relative_path FROM workflow_folders WHERE relative_path = $1', [folderRelativePath])) {
        throw conflict(`Folder already exists: ${folderName}`);
      }

      await this.#assertFolderExists(client, parentPath);
      await client.query(
        `
          INSERT INTO workflow_folders (relative_path, name, parent_relative_path, updated_at)
          VALUES ($1, $2, $3, NOW())
        `,
        [folderRelativePath, folderName, parentPath],
      );

      return mapFolderRowToFolderItem({
        relative_path: folderRelativePath,
        name: folderName,
        parent_relative_path: parentPath,
        updated_at: new Date(),
      });
    });
  }

  async renameWorkflowFolderItem(relativePath: unknown, newName: unknown): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    const sourceRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: false });
    const folderName = sanitizeWorkflowName(newName, 'new folder name');
    const parentRelativePath = path.posix.dirname(sourceRelativePath) === '.' ? '' : path.posix.dirname(sourceRelativePath);
    const targetRelativePath = parentRelativePath ? `${parentRelativePath}/${folderName}` : folderName;

    if (sourceRelativePath === targetRelativePath) {
      const folderRow = await queryOne<FolderRow>(this.#pool, `
        SELECT relative_path, name, parent_relative_path, updated_at
        FROM workflow_folders WHERE relative_path = $1
      `, [sourceRelativePath]);
      if (!folderRow) {
        throw createHttpError(404, 'Folder not found');
      }

      return {
        folder: mapFolderRowToFolderItem(folderRow),
        movedProjectPaths: [],
      };
    }

    if (targetRelativePath.startsWith(`${sourceRelativePath}/`)) {
      throw badRequest('Cannot move a folder into itself');
    }

    return this.#moveFolderRelativePath(sourceRelativePath, targetRelativePath);
  }

  async moveWorkflowFolder(sourceRelativePath: unknown, destinationFolderRelativePath: unknown): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    const sourcePath = normalizeManagedWorkflowRelativePath(sourceRelativePath, { allowProjectFile: false });
    const destinationFolderPath = normalizeManagedWorkflowRelativePath(destinationFolderRelativePath, { allowProjectFile: false, allowEmpty: true });
    const targetRelativePath = destinationFolderPath
      ? `${destinationFolderPath}/${path.posix.basename(sourcePath)}`
      : path.posix.basename(sourcePath);

    if (destinationFolderPath === sourcePath || destinationFolderPath.startsWith(`${sourcePath}/`)) {
      throw badRequest('Cannot move a folder into itself');
    }

    if (targetRelativePath === sourcePath) {
      const folderRow = await queryOne<FolderRow>(this.#pool, `
        SELECT relative_path, name, parent_relative_path, updated_at
        FROM workflow_folders WHERE relative_path = $1
      `, [sourcePath]);
      if (!folderRow) {
        throw createHttpError(404, 'Folder not found');
      }

      return {
        folder: mapFolderRowToFolderItem(folderRow),
        movedProjectPaths: [],
      };
    }

    return this.#moveFolderRelativePath(sourcePath, targetRelativePath);
  }

  async #moveFolderRelativePath(sourceRelativePath: string, targetRelativePath: string): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    try {
      return await this.#withTransaction(async (client) => {
        const temporaryPrefix = `.__move__-${randomUUID()}`;
        const folderName = path.posix.basename(targetRelativePath);
        const folderRow = await queryOne<FolderMoveRow>(
          client,
          `
            SELECT relative_path, name, parent_relative_path, updated_at, moved_relative_paths
            FROM move_managed_workflow_folder($1, $2, $3, $4)
          `,
          [
            sourceRelativePath,
            temporaryPrefix,
            targetRelativePath,
            folderName,
          ],
        );

        if (!folderRow) {
          throw createHttpError(500, 'Moved folder could not be loaded');
        }

        const movedProjectPaths = (folderRow.moved_relative_paths ?? []).map((relativePath) => ({
          fromAbsolutePath: getManagedWorkflowProjectVirtualPath(relativePath),
          toAbsolutePath: getManagedWorkflowProjectVirtualPath(
            `${targetRelativePath}${relativePath.slice(sourceRelativePath.length)}`,
          ),
        }));

        return {
          folder: mapFolderRowToFolderItem(folderRow),
          movedProjectPaths,
        };
      });
    } catch (error) {
      if (typeof error === 'object' && error != null && 'code' in error && String((error as { code?: unknown }).code ?? '') === 'P0002') {
        throw createHttpError(404, 'Folder not found');
      }

      if (isUniqueViolation(error)) {
        throw conflict(`Folder already exists: ${path.posix.basename(targetRelativePath)}`);
      }

      throw error;
    }
  }

  async deleteWorkflowFolderItem(relativePath: unknown): Promise<void> {
    const folderRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: false });

    await this.#withTransaction(async (client) => {
      await this.#assertFolderExists(client, folderRelativePath);

      const childFolder = await queryOne(client, 'SELECT relative_path FROM workflow_folders WHERE parent_relative_path = $1 LIMIT 1', [folderRelativePath]);
      const childProject = await queryOne(client, 'SELECT workflow_id FROM workflows WHERE folder_relative_path = $1 LIMIT 1', [folderRelativePath]);
      if (childFolder || childProject) {
        throw conflict('Only empty folders can be deleted');
      }

      await client.query('DELETE FROM workflow_folders WHERE relative_path = $1', [folderRelativePath]);
    });
  }

  async createWorkflowProjectItem(folderRelativePath: unknown, name: unknown): Promise<WorkflowProjectItem> {
    const normalizedFolderPath = normalizeManagedWorkflowRelativePath(folderRelativePath, { allowProjectFile: false, allowEmpty: true });
    const projectName = sanitizeWorkflowName(name, 'project name');
    const relativePath = normalizedFolderPath ? `${normalizedFolderPath}/${projectName}${WORKFLOW_PROJECT_EXTENSION}` : `${projectName}${WORKFLOW_PROJECT_EXTENSION}`;

    await this.#assertFolderExists(this.#pool, normalizedFolderPath);

    const result = await this.saveHostedProject({
      projectPath: getManagedWorkflowProjectVirtualPath(relativePath),
      contents: createBlankProjectFile(projectName),
      datasetsContents: null,
    });

    return result.project;
  }

  async renameWorkflowProjectItem(relativePath: unknown, newName: unknown): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    const sourceRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
    const projectName = sanitizeWorkflowName(newName, 'new project name');
    const folderRelativePath = path.posix.dirname(sourceRelativePath) === '.' ? '' : path.posix.dirname(sourceRelativePath);
    const targetRelativePath = folderRelativePath ? `${folderRelativePath}/${projectName}${WORKFLOW_PROJECT_EXTENSION}` : `${projectName}${WORKFLOW_PROJECT_EXTENSION}`;

    return this.#moveWorkflowProjectRelativePath(sourceRelativePath, targetRelativePath);
  }

  async moveWorkflowProject(sourceRelativePath: unknown, destinationFolderRelativePath: unknown): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    const sourcePath = normalizeManagedWorkflowRelativePath(sourceRelativePath, { allowProjectFile: true });
    const destinationFolderPath = normalizeManagedWorkflowRelativePath(destinationFolderRelativePath, { allowProjectFile: false, allowEmpty: true });
    const targetRelativePath = destinationFolderPath
      ? `${destinationFolderPath}/${path.posix.basename(sourcePath)}`
      : path.posix.basename(sourcePath);

    return this.#moveWorkflowProjectRelativePath(sourcePath, targetRelativePath);
  }

  async #moveWorkflowProjectRelativePath(sourceRelativePath: string, targetRelativePath: string): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    if (sourceRelativePath === targetRelativePath) {
      const workflow = await this.#getWorkflowByRelativePath(this.#pool, sourceRelativePath);
      if (!workflow) {
        throw createHttpError(404, 'Project not found');
      }

      return {
        project: mapWorkflowRowToProjectItem(workflow),
        movedProjectPaths: [],
      };
    }

    return this.#withTransaction(async (client) => {
      const workflow = await this.#getWorkflowByRelativePath(client, sourceRelativePath, { forUpdate: true });
      if (!workflow) {
        throw createHttpError(404, 'Project not found');
      }

      if (await this.#getWorkflowByRelativePath(client, targetRelativePath)) {
        throw conflict(`Project already exists: ${path.posix.basename(targetRelativePath)}`);
      }

      const folderRelativePath = path.posix.dirname(targetRelativePath) === '.' ? '' : path.posix.dirname(targetRelativePath);
      await this.#assertFolderExists(client, folderRelativePath);

      const projectName = path.posix.basename(targetRelativePath, WORKFLOW_PROJECT_EXTENSION);
      await client.query(
        `
          UPDATE workflows
          SET name = $2,
              file_name = $3,
              relative_path = $4,
              folder_relative_path = $5,
              updated_at = NOW()
          WHERE workflow_id = $1
        `,
        [workflow.workflow_id, projectName, `${projectName}${WORKFLOW_PROJECT_EXTENSION}`, targetRelativePath, folderRelativePath],
      );

      const movedWorkflow = await this.#getWorkflowByRelativePath(client, targetRelativePath, { forUpdate: true });
      if (!movedWorkflow) {
        throw createHttpError(500, 'Moved project could not be loaded');
      }

      return {
        project: mapWorkflowRowToProjectItem(movedWorkflow),
        movedProjectPaths: [{
          fromAbsolutePath: getManagedWorkflowProjectVirtualPath(sourceRelativePath),
          toAbsolutePath: getManagedWorkflowProjectVirtualPath(targetRelativePath),
        }],
      };
    });
  }

  async duplicateWorkflowProjectItem(relativePath: unknown, version: WorkflowProjectDownloadVersion = 'live'): Promise<WorkflowProjectItem> {
    const sourceRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });

    return this.#withTransaction(async (client) => {
      const workflow = await this.#getWorkflowByRelativePath(client, sourceRelativePath, { forUpdate: true });
      if (!workflow) {
        throw createHttpError(404, 'Project not found');
      }

      const status = getWorkflowStatus(workflow);
      const sourceRevisionId = version === 'published' ? workflow.published_revision_id : workflow.current_draft_revision_id;
      if (version === 'published' && !sourceRevisionId) {
        throw conflict('Published version is not available for this project');
      }

      const sourceRevision = await this.#getRevision(client, sourceRevisionId);
      if (!sourceRevision) {
        throw createHttpError(404, 'Project revision not found');
      }

      const sourceContents = await this.#readRevisionContents(sourceRevision);
      const [sourceProject, sourceAttachedData] = loadProjectAndAttachedDataFromString(sourceContents.contents);
      sourceProject.metadata.id = randomUUID() as typeof sourceProject.metadata.id;

      for (let duplicateIndex = 0; ; duplicateIndex += 1) {
        const duplicateProjectName = getWorkflowDuplicateProjectName(workflow.name, version, status, duplicateIndex);
        const duplicateRelativePath = workflow.folder_relative_path
          ? `${workflow.folder_relative_path}/${duplicateProjectName}${WORKFLOW_PROJECT_EXTENSION}`
          : `${duplicateProjectName}${WORKFLOW_PROJECT_EXTENSION}`;

        if (await this.#getWorkflowByRelativePath(client, duplicateRelativePath)) {
          continue;
        }

        sourceProject.metadata.title = duplicateProjectName;
        const serialized = serializeProject(sourceProject, sourceAttachedData);
        if (typeof serialized !== 'string') {
          throw createHttpError(400, 'Could not duplicate project');
        }

        const result = await this.saveHostedProject({
          projectPath: getManagedWorkflowProjectVirtualPath(duplicateRelativePath),
          contents: serialized,
          datasetsContents: null,
        });
        return result.project;
      }
    });
  }

  async uploadWorkflowProjectItem(folderRelativePath: unknown, fileName: unknown, contents: unknown): Promise<WorkflowProjectItem> {
    const normalizedFolderPath = normalizeManagedWorkflowRelativePath(folderRelativePath, { allowProjectFile: false, allowEmpty: true });
    await this.#assertFolderExists(this.#pool, normalizedFolderPath);

    if (typeof fileName !== 'string' || !fileName.trim()) {
      throw createHttpError(400, 'Missing fileName');
    }
    if (typeof contents !== 'string' || !contents.trim()) {
      throw createHttpError(400, 'Missing project contents');
    }

    let sourceProject: Project;
    let attachedData: AttachedData;
    try {
      [sourceProject, attachedData] = loadProjectAndAttachedDataFromString(contents);
    } catch {
      throw createHttpError(400, 'Could not upload project: invalid project file');
    }

    const sourceBaseName = sanitizeWorkflowName(
      fileName.trim().replace(/\\/g, '/').split('/').pop()?.replace(/\.rivet-project$/i, '') ?? '',
      'project file name',
    );

    for (let uploadIndex = 0; ; uploadIndex += 1) {
      const uploadedProjectName = uploadIndex === 0 ? sourceBaseName : `${sourceBaseName} ${uploadIndex}`;
      const uploadedRelativePath = normalizedFolderPath
        ? `${normalizedFolderPath}/${uploadedProjectName}${WORKFLOW_PROJECT_EXTENSION}`
        : `${uploadedProjectName}${WORKFLOW_PROJECT_EXTENSION}`;

      if (await this.#getWorkflowByRelativePath(this.#pool, uploadedRelativePath)) {
        continue;
      }

      sourceProject.metadata.id = randomUUID() as typeof sourceProject.metadata.id;
      sourceProject.metadata.title = uploadedProjectName;
      const serialized = serializeProject(sourceProject, attachedData);
      if (typeof serialized !== 'string') {
        throw createHttpError(400, 'Could not upload project: invalid project file');
      }

      const result = await this.saveHostedProject({
        projectPath: getManagedWorkflowProjectVirtualPath(uploadedRelativePath),
        contents: serialized,
        datasetsContents: null,
      });
      return result.project;
    }
  }

  async readWorkflowProjectDownload(relativePath: unknown, version: WorkflowProjectDownloadVersion): Promise<{ contents: string; fileName: string }> {
    const workflow = await this.#getWorkflowByRelativePath(this.#pool, normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true }));
    if (!workflow) {
      throw createHttpError(404, 'Project not found');
    }

    const revisionId = version === 'published' ? workflow.published_revision_id : workflow.current_draft_revision_id;
    if (version === 'published' && !revisionId) {
      throw conflict('Published version is not available for this project');
    }

    const revision = await this.#getRevision(this.#pool, revisionId);
    if (!revision) {
      throw createHttpError(404, 'Project revision not found');
    }

    const contents = await this.#blobStore.getText(revision.project_blob_key);
    return {
      contents,
      fileName: getWorkflowDownloadFileName(workflow.name, version, getWorkflowStatus(workflow)),
    };
  }

  async publishWorkflowProjectItem(relativePath: unknown, settings: unknown): Promise<WorkflowProjectItem> {
    const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
    const normalizedSettings = (() => {
      const raw = (settings ?? {}) as WorkflowProjectSettingsDraft;
      return {
        endpointName: normalizeStoredEndpointName(String(raw.endpointName ?? '')),
      };
    })();

    if (!normalizedSettings.endpointName) {
      throw badRequest('Endpoint name is required');
    }

    return this.#withTransaction(async (client) => {
      const workflow = await this.#getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
      if (!workflow) {
        throw createHttpError(404, 'Project not found');
      }

      await this.#syncWorkflowEndpointRows(client, workflow, {
        draftEndpointName: normalizedSettings.endpointName,
        publishedEndpointName: normalizedSettings.endpointName,
      });

      await client.query(
        `
          UPDATE workflows
          SET endpoint_name = $2,
              published_endpoint_name = $2,
              published_revision_id = current_draft_revision_id,
              last_published_at = NOW(),
              updated_at = NOW()
          WHERE workflow_id = $1
        `,
        [workflow.workflow_id, normalizedSettings.endpointName],
      );

      const publishedWorkflow = await this.#getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
      if (!publishedWorkflow) {
        throw createHttpError(500, 'Published workflow could not be loaded');
      }

      return mapWorkflowRowToProjectItem(publishedWorkflow);
    });
  }

  async unpublishWorkflowProjectItem(relativePath: unknown): Promise<WorkflowProjectItem> {
    const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });

    return this.#withTransaction(async (client) => {
      const workflow = await this.#getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
      if (!workflow) {
        throw createHttpError(404, 'Project not found');
      }

      await client.query(
        `
          UPDATE workflows
          SET published_revision_id = NULL,
              published_endpoint_name = '',
              updated_at = NOW()
          WHERE workflow_id = $1
        `,
        [workflow.workflow_id],
      );

      await this.#syncWorkflowEndpointRows(client, workflow, {
        draftEndpointName: workflow.endpoint_name,
        publishedEndpointName: '',
      });

      const unpublishedWorkflow = await this.#getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
      if (!unpublishedWorkflow) {
        throw createHttpError(500, 'Unpublished workflow could not be loaded');
      }

      return mapWorkflowRowToProjectItem(unpublishedWorkflow);
    });
  }

  async deleteWorkflowProjectItem(relativePath: unknown): Promise<void> {
    const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });

    await this.#withTransaction(async (client, hooks) => {
      const workflow = await this.#getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
      if (!workflow) {
        throw createHttpError(404, 'Project not found');
      }

      const revisions = await queryRows<RevisionRow>(
        client,
        'SELECT revision_id, workflow_id, project_blob_key, dataset_blob_key, created_at FROM workflow_revisions WHERE workflow_id = $1',
        [workflow.workflow_id],
      );
      const recordings = await queryRows<RecordingRow>(
        client,
        `
          SELECT recording_id, workflow_id, source_project_name, source_project_relative_path, created_at, run_kind, status, duration_ms,
                 endpoint_name_at_execution, error_message, recording_blob_key, replay_project_blob_key, replay_dataset_blob_key,
                 has_replay_dataset, recording_compressed_bytes, recording_uncompressed_bytes, project_compressed_bytes,
                 project_uncompressed_bytes, dataset_compressed_bytes, dataset_uncompressed_bytes
          FROM workflow_recordings
          WHERE workflow_id = $1
        `,
        [workflow.workflow_id],
      );

      await client.query('DELETE FROM workflows WHERE workflow_id = $1', [workflow.workflow_id]);
      hooks.onCommit(() => this.#deleteBlobKeysBestEffort(
        `workflow deletion (${workflow.workflow_id})`,
        [
          ...revisions.flatMap((revision) => [revision.project_blob_key, revision.dataset_blob_key]),
          ...recordings.flatMap((recording) => [
            recording.recording_blob_key,
            recording.replay_project_blob_key,
            recording.replay_dataset_blob_key,
          ]),
        ],
      ));
    });
  }

  async resolvePublishedWorkflowByEndpoint(endpointName: string): Promise<ExecutionWorkflowMatch | null> {
    await this.initialize();
    const lookupName = normalizeWorkflowEndpointLookupName(endpointName);
    const workflow = await queryOne<WorkflowRow>(
      this.#pool,
      `
        SELECT w.workflow_id, w.name, w.file_name, w.relative_path, w.folder_relative_path, w.updated_at,
               w.current_draft_revision_id, w.published_revision_id, w.endpoint_name, w.published_endpoint_name, w.last_published_at
        FROM workflow_endpoints e
        JOIN workflows w ON w.workflow_id = e.workflow_id
        WHERE e.lookup_name = $1 AND e.is_published = TRUE
      `,
      [lookupName],
    );
    if (!workflow || !workflow.published_revision_id) {
      return null;
    }

    const revision = await this.#getRevision(this.#pool, workflow.published_revision_id);
    if (!revision) {
      return null;
    }

    return { workflow, revision };
  }

  async resolveLatestWorkflowByEndpoint(endpointName: string): Promise<ExecutionWorkflowMatch | null> {
    await this.initialize();
    const lookupName = normalizeWorkflowEndpointLookupName(endpointName);
    const workflow = await queryOne<WorkflowRow>(
      this.#pool,
      `
        SELECT w.workflow_id, w.name, w.file_name, w.relative_path, w.folder_relative_path, w.updated_at,
               w.current_draft_revision_id, w.published_revision_id, w.endpoint_name, w.published_endpoint_name, w.last_published_at
        FROM workflow_endpoints e
        JOIN workflows w ON w.workflow_id = e.workflow_id
        WHERE e.lookup_name = $1 AND e.is_published = TRUE
      `,
      [lookupName],
    );
    if (!workflow) {
      return null;
    }

    const revision = await this.#getRevision(this.#pool, workflow.current_draft_revision_id);
    if (!revision) {
      return null;
    }

    return { workflow, revision };
  }

  async loadExecutionProject(match: ExecutionWorkflowMatch): Promise<{
    project: Project;
    attachedData: AttachedData;
    datasetProvider: NodeDatasetProvider;
    projectVirtualPath: string;
  }> {
    const contents = await this.#readRevisionContents(match.revision);
    const [project, attachedData] = loadProjectAndAttachedDataFromString(contents.contents);
    const datasetProvider = new NodeDatasetProvider(
      contents.datasetsContents ? deserializeDatasets(contents.datasetsContents) : [],
    );

    return {
      project,
      attachedData,
      datasetProvider,
      projectVirtualPath: getManagedWorkflowProjectVirtualPath(match.workflow.relative_path),
    };
  }

  createProjectReferenceLoader() {
    const backend = this;

    return {
      async loadProject(currentProjectPath: string | undefined, reference: { id: string; hintPaths?: string[]; title?: string }) {
        if (!currentProjectPath) {
          throw new Error(`Could not load project "${reference.title ?? reference.id}" because the current project path is missing.`);
        }

        for (const hintPath of reference.hintPaths ?? []) {
          try {
            const relativePath = resolveManagedWorkflowRelativeReference(currentProjectPath, hintPath);
            const workflow = await backend.#getWorkflowByRelativePath(backend.#pool, relativePath);
            if (workflow) {
              const revision = await backend.#getRevision(backend.#pool, workflow.published_revision_id ?? workflow.current_draft_revision_id);
              if (revision) {
                const contents = await backend.#blobStore.getText(revision.project_blob_key);
                return loadProjectFromString(contents);
              }
            }
          } catch {
          }
        }

        const workflowById = await backend.#getWorkflowById(backend.#pool, reference.id);
        if (workflowById) {
          const revision = await backend.#getRevision(backend.#pool, workflowById.published_revision_id ?? workflowById.current_draft_revision_id);
          if (revision) {
            const contents = await backend.#blobStore.getText(revision.project_blob_key);
            return loadProjectFromString(contents);
          }
        }

        throw new Error(`Could not load project "${reference.title ?? reference.id} (${reference.id})": all hint paths failed.`);
      },
    };
  }

  async importWorkflowRecording(options: ImportManagedWorkflowRecordingOptions): Promise<void> {
    await this.initialize();

    const createdAt = options.createdAt.trim() || new Date().toISOString();
    const recordingBlobKey = createRecordingBlobKey(options.workflowId, options.recordingId, 'recording');
    const replayProjectBlobKey = createRecordingBlobKey(options.workflowId, options.recordingId, 'replay-project');
    const replayDatasetBlobKey = options.replayDatasetContents != null
      ? createRecordingBlobKey(options.workflowId, options.recordingId, 'replay-dataset')
      : null;
    const existingRecording = await queryOne<{ recording_id: string }>(
      this.#pool,
      'SELECT recording_id FROM workflow_recordings WHERE recording_id = $1',
      [options.recordingId],
    );
    if (existingRecording) {
      return;
    }

    const uploadedBlobKeys = [recordingBlobKey, replayProjectBlobKey, replayDatasetBlobKey];

    try {
      await Promise.all([
        this.#blobStore.putText(recordingBlobKey, options.recordingContents, 'text/plain; charset=utf-8'),
        this.#blobStore.putText(replayProjectBlobKey, options.replayProjectContents, 'application/x-yaml; charset=utf-8'),
        replayDatasetBlobKey && options.replayDatasetContents != null
          ? this.#blobStore.putText(replayDatasetBlobKey, options.replayDatasetContents, 'text/plain; charset=utf-8')
          : Promise.resolve(),
      ]);
    } catch (error) {
      await this.#deleteBlobKeysBestEffort('recording import upload failure', uploadedBlobKeys);
      throw error;
    }

    try {
      await this.#pool.query(
        `
          INSERT INTO workflow_recordings (
            recording_id, workflow_id, source_project_name, source_project_relative_path, created_at,
            run_kind, status, duration_ms, endpoint_name_at_execution, error_message,
            recording_blob_key, replay_project_blob_key, replay_dataset_blob_key, has_replay_dataset,
            recording_compressed_bytes, recording_uncompressed_bytes, project_compressed_bytes, project_uncompressed_bytes,
            dataset_compressed_bytes, dataset_uncompressed_bytes
          )
          VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
          ON CONFLICT (recording_id) DO NOTHING
        `,
        [
          options.recordingId,
          options.workflowId,
          options.sourceProjectName,
          options.sourceProjectRelativePath,
          createdAt,
          options.runKind,
          options.status,
          Math.max(0, Math.round(options.durationMs)),
          options.endpointName,
          options.errorMessage ?? null,
          recordingBlobKey,
          replayProjectBlobKey,
          replayDatasetBlobKey,
          Boolean(replayDatasetBlobKey),
          options.recordingContents.length,
          options.recordingContents.length,
          options.replayProjectContents.length,
          options.replayProjectContents.length,
          options.replayDatasetContents?.length ?? 0,
          options.replayDatasetContents?.length ?? 0,
        ],
      );
    } catch (error) {
      await this.#deleteBlobKeysBestEffort('recording import failure', uploadedBlobKeys);
      throw error;
    }
  }

  async listWorkflowRecordingWorkflows(): Promise<WorkflowRecordingWorkflowListResponse> {
    await this.initialize();
    const rows = await queryRows<WorkflowRecordingListRow>(
      this.#pool,
      `
        SELECT w.workflow_id, w.name, w.file_name, w.relative_path, w.folder_relative_path, w.updated_at,
               w.current_draft_revision_id, w.published_revision_id, w.endpoint_name, w.published_endpoint_name, w.last_published_at,
               r.total_runs, r.failed_runs, r.suspicious_runs, r.latest_run_at
        FROM workflows w
        LEFT JOIN (
          SELECT workflow_id,
                 COUNT(*)::int AS total_runs,
                 COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_runs,
                 COUNT(*) FILTER (WHERE status = 'suspicious')::int AS suspicious_runs,
                 MAX(created_at) AS latest_run_at
          FROM workflow_recordings
          GROUP BY workflow_id
        ) r ON r.workflow_id = w.workflow_id
        ORDER BY w.relative_path ASC
      `,
    );

    const workflows = rows
      .filter((row) => (row.total_runs ?? 0) > 0 || (getWorkflowStatus(row) !== 'unpublished' && Boolean(row.endpoint_name)))
      .map((row) => ({
        workflowId: row.workflow_id,
        project: mapWorkflowRowToProjectItem(row),
        latestRunAt: toIsoString(row.latest_run_at) ?? undefined,
        totalRuns: row.total_runs ?? 0,
        failedRuns: row.failed_runs ?? 0,
        suspiciousRuns: row.suspicious_runs ?? 0,
      }))
      .sort((left, right) => {
        const latestLeft = left.latestRunAt ?? '';
        const latestRight = right.latestRunAt ?? '';
        if (latestLeft && latestRight && latestLeft !== latestRight) {
          return latestRight.localeCompare(latestLeft);
        }

        if (latestLeft && !latestRight) {
          return -1;
        }

        if (!latestLeft && latestRight) {
          return 1;
        }

        return left.project.name.localeCompare(right.project.name);
      });

    return { workflows };
  }

  async listWorkflowRecordingRunsPage(
    workflowId: string,
    page: number,
    pageSize: number,
    statusFilter: WorkflowRecordingFilterStatus,
  ): Promise<WorkflowRecordingRunsPageResponse> {
    await this.initialize();
    const normalizedPage = Math.max(1, Math.floor(page));
    const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
    const offset = (normalizedPage - 1) * normalizedPageSize;
    const filterClause = statusFilter === 'failed'
      ? `AND status IN ('failed', 'suspicious')`
      : '';

    const countRow = await queryOne<{ total_runs: number }>(
      this.#pool,
      `SELECT COUNT(*)::int AS total_runs FROM workflow_recordings WHERE workflow_id = $1 ${filterClause}`,
      [workflowId],
    );
    const rows = await queryRows<RecordingRow>(
      this.#pool,
      `
        SELECT recording_id, workflow_id, source_project_name, source_project_relative_path, created_at, run_kind, status, duration_ms,
               endpoint_name_at_execution, error_message, recording_blob_key, replay_project_blob_key, replay_dataset_blob_key,
               has_replay_dataset, recording_compressed_bytes, recording_uncompressed_bytes, project_compressed_bytes,
               project_uncompressed_bytes, dataset_compressed_bytes, dataset_uncompressed_bytes
        FROM workflow_recordings
        WHERE workflow_id = $1 ${filterClause}
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `,
      [workflowId, normalizedPageSize, offset],
    );

    const runs: WorkflowRecordingRunSummary[] = rows.map((row) => ({
      id: row.recording_id,
      workflowId: row.workflow_id,
      createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
      runKind: row.run_kind,
      status: row.status,
      durationMs: row.duration_ms,
      endpointNameAtExecution: row.endpoint_name_at_execution,
      errorMessage: row.error_message ?? undefined,
      hasReplayDataset: row.has_replay_dataset,
      recordingCompressedBytes: row.recording_compressed_bytes,
      recordingUncompressedBytes: row.recording_uncompressed_bytes,
      projectCompressedBytes: row.project_compressed_bytes,
      projectUncompressedBytes: row.project_uncompressed_bytes,
      datasetCompressedBytes: row.dataset_compressed_bytes,
      datasetUncompressedBytes: row.dataset_uncompressed_bytes,
    }));

    return {
      workflowId,
      page: normalizedPage,
      pageSize: normalizedPageSize,
      totalRuns: countRow?.total_runs ?? 0,
      statusFilter,
      runs,
    };
  }

  async readWorkflowRecordingArtifact(recordingId: string, artifact: 'recording' | 'replay-project' | 'replay-dataset'): Promise<string> {
    await this.initialize();
    const row = await queryOne<RecordingRow>(
      this.#pool,
      `
        SELECT recording_id, workflow_id, source_project_name, source_project_relative_path, created_at, run_kind, status, duration_ms,
               endpoint_name_at_execution, error_message, recording_blob_key, replay_project_blob_key, replay_dataset_blob_key,
               has_replay_dataset, recording_compressed_bytes, recording_uncompressed_bytes, project_compressed_bytes,
               project_uncompressed_bytes, dataset_compressed_bytes, dataset_uncompressed_bytes
        FROM workflow_recordings
        WHERE recording_id = $1
      `,
      [recordingId],
    );
    if (!row) {
      throw createHttpError(404, 'Recording not found');
    }

    if (artifact === 'replay-dataset' && !row.replay_dataset_blob_key) {
      throw createHttpError(404, 'Replay dataset not found');
    }

    return artifact === 'recording'
      ? this.#blobStore.getText(row.recording_blob_key)
      : artifact === 'replay-project'
        ? this.#blobStore.getText(row.replay_project_blob_key)
        : this.#blobStore.getText(row.replay_dataset_blob_key!);
  }

  async deleteWorkflowRecording(recordingId: string): Promise<void> {
    await this.#withTransaction(async (client, hooks) => {
      const row = await queryOne<RecordingRow>(
        client,
        `
          SELECT recording_id, workflow_id, source_project_name, source_project_relative_path, created_at, run_kind, status, duration_ms,
                 endpoint_name_at_execution, error_message, recording_blob_key, replay_project_blob_key, replay_dataset_blob_key,
                 has_replay_dataset, recording_compressed_bytes, recording_uncompressed_bytes, project_compressed_bytes,
                 project_uncompressed_bytes, dataset_compressed_bytes, dataset_uncompressed_bytes
          FROM workflow_recordings
          WHERE recording_id = $1
          FOR UPDATE
        `,
        [recordingId],
      );
      if (!row) {
        throw createHttpError(404, 'Recording not found');
      }

      await client.query('DELETE FROM workflow_recordings WHERE recording_id = $1', [recordingId]);
      hooks.onCommit(() => this.#deleteBlobKeysBestEffort(
        `recording deletion (${recordingId})`,
        [row.recording_blob_key, row.replay_project_blob_key, row.replay_dataset_blob_key],
      ));
    });
  }

  async persistWorkflowExecutionRecording(options: PersistWorkflowExecutionRecordingOptions): Promise<void> {
    await this.initialize();

    const workflowId = options.sourceProject.metadata.id;
    if (!workflowId) {
      return;
    }

    const recordingId = `${Date.now()}-${randomUUID()}`;
    const replayProject: Project = {
      ...options.executedProject,
      metadata: {
        ...options.executedProject.metadata,
        id: randomUUID() as Project['metadata']['id'],
      },
    };
    const replayProjectSerialized = serializeProject(replayProject, options.executedAttachedData);
    if (typeof replayProjectSerialized !== 'string') {
      throw new Error('Serialized replay project is not a string');
    }

    const recordingBlobKey = createRecordingBlobKey(workflowId, recordingId, 'recording');
    const replayProjectBlobKey = createRecordingBlobKey(workflowId, recordingId, 'replay-project');
    const replayDatasetBlobKey = options.executedDatasets.length > 0
      ? createRecordingBlobKey(workflowId, recordingId, 'replay-dataset')
      : null;
    const replayDatasetSerialized = replayDatasetBlobKey ? serializeDatasets(options.executedDatasets) : null;
    const uploadedBlobKeys = [recordingBlobKey, replayProjectBlobKey, replayDatasetBlobKey];

    try {
      await Promise.all([
        this.#blobStore.putText(recordingBlobKey, options.recordingSerialized, 'text/plain; charset=utf-8'),
        this.#blobStore.putText(replayProjectBlobKey, replayProjectSerialized, 'application/x-yaml; charset=utf-8'),
        replayDatasetBlobKey && replayDatasetSerialized != null
          ? this.#blobStore.putText(replayDatasetBlobKey, replayDatasetSerialized, 'text/plain; charset=utf-8')
          : Promise.resolve(),
      ]);
    } catch (error) {
      await this.#deleteBlobKeysBestEffort('recording persistence upload failure', uploadedBlobKeys);
      throw error;
    }

    try {
      await this.#pool.query(
        `
          INSERT INTO workflow_recordings (
            recording_id, workflow_id, source_project_name, source_project_relative_path, created_at,
            run_kind, status, duration_ms, endpoint_name_at_execution, error_message,
            recording_blob_key, replay_project_blob_key, replay_dataset_blob_key, has_replay_dataset,
            recording_compressed_bytes, recording_uncompressed_bytes, project_compressed_bytes, project_uncompressed_bytes,
            dataset_compressed_bytes, dataset_uncompressed_bytes
          )
          VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        `,
        [
          recordingId,
          workflowId,
          path.posix.basename(options.sourceProjectPath, WORKFLOW_PROJECT_EXTENSION),
          parseManagedWorkflowProjectVirtualPath(options.sourceProjectPath),
          options.runKind,
          options.status,
          Math.max(0, Math.round(options.durationMs)),
          options.endpointName,
          options.errorMessage ?? null,
          recordingBlobKey,
          replayProjectBlobKey,
          replayDatasetBlobKey,
          Boolean(replayDatasetBlobKey),
          options.recordingSerialized.length,
          options.recordingSerialized.length,
          replayProjectSerialized.length,
          replayProjectSerialized.length,
          replayDatasetSerialized?.length ?? 0,
          replayDatasetSerialized?.length ?? 0,
        ],
      );
    } catch (error) {
      await this.#deleteBlobKeysBestEffort('recording persistence failure', uploadedBlobKeys);
      throw error;
    }
  }
}
