import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadProjectAndAttachedDataFromString, serializeProject } from '@ironclad/rivet-node';
import { type Pool, type PoolClient } from 'pg';

import { WORKFLOW_PROJECT_EXTENSION } from '../../../../../shared/workflow-types.js';
import { conflict, createHttpError } from '../../../utils/httpError.js';
import { normalizeStoredEndpointName } from '../publication.js';
import {
  getManagedWorkflowProjectVirtualPath,
  normalizeManagedWorkflowRelativePath,
  parseManagedWorkflowProjectVirtualPath,
} from '../virtual-paths.js';
import type {
  ImportManagedWorkflowOptions,
  LoadHostedProjectResult,
  ManagedRevisionContents,
  RevisionRow,
  SaveHostedProjectResult,
  TransactionHooks,
  WorkflowRow,
} from './types.js';

type ManagedWorkflowRevisionServiceDependencies = {
  pool: Pool;
  initialize(): Promise<void>;
  withTransaction<T>(run: (client: PoolClient, hooks: TransactionHooks) => Promise<T>): Promise<T>;
  ensureFolderChain(client: PoolClient, folderRelativePath: string): Promise<void>;
  getWorkflowByRelativePath(
    client: PoolClient | Pool,
    relativePath: string,
    options?: { forUpdate?: boolean },
  ): Promise<WorkflowRow | null>;
  getWorkflowById(client: PoolClient | Pool, workflowId: string): Promise<WorkflowRow | null>;
  getRevision(client: PoolClient | Pool, revisionId: string | null | undefined): Promise<RevisionRow | null>;
  getCurrentDraftWorkflowRevision(
    client: PoolClient | Pool,
    relativePath: string,
  ): Promise<{ workflow: WorkflowRow; revision: RevisionRow } | null>;
  readRevisionContents(revision: RevisionRow): Promise<ManagedRevisionContents>;
  createRevision(workflowId: string, contents: string, datasetsContents: string | null): Promise<RevisionRow>;
  scheduleRevisionBlobCleanup(
    hooks: TransactionHooks,
    revision: Pick<RevisionRow, 'project_blob_key' | 'dataset_blob_key'>,
  ): void;
  insertRevision(client: PoolClient, revision: RevisionRow): Promise<void>;
  syncWorkflowEndpointRows(
    client: PoolClient,
    workflow: WorkflowRow,
    endpoints: { draftEndpointName: string; publishedEndpointName: string },
  ): Promise<void>;
  mapWorkflowRowToProjectItem(row: WorkflowRow): SaveHostedProjectResult['project'];
  resolveManagedHostedProjectSaveTarget(options: {
    nextContents: ManagedRevisionContents;
    currentDraftContents: ManagedRevisionContents;
    publishedContents: ManagedRevisionContents | null;
    draftEndpointName: string;
    publishedEndpointName: string;
  }): 'current-draft' | 'published-revision' | 'create-revision';
  queueWorkflowInvalidation(client: PoolClient, hooks: TransactionHooks, workflowId: string): Promise<void>;
};

export function createManagedWorkflowRevisionService(deps: ManagedWorkflowRevisionServiceDependencies) {
  return {
    async loadHostedProject(projectPath: string): Promise<LoadHostedProjectResult> {
      await deps.initialize();
      const relativePath = parseManagedWorkflowProjectVirtualPath(projectPath);
      const loaded = await deps.getCurrentDraftWorkflowRevision(deps.pool, relativePath);
      if (!loaded) {
        throw createHttpError(404, 'Project revision not found');
      }

      const contents = await deps.readRevisionContents(loaded.revision);
      return {
        ...contents,
        revisionId: loaded.revision.revision_id,
      };
    },

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

      return deps.withTransaction(async (client, hooks) => {
        await deps.ensureFolderChain(client, folderRelativePath);

        let workflow = await deps.getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
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

          const currentDraftRevision = await deps.getRevision(client, workflow.current_draft_revision_id);
          if (!currentDraftRevision) {
            throw createHttpError(500, 'Current workflow revision could not be loaded');
          }

          const currentDraftContents = await deps.readRevisionContents(currentDraftRevision);
          let publishedContents: ManagedRevisionContents | null = null;

          if (workflow.published_revision_id) {
            if (workflow.published_revision_id === currentDraftRevision.revision_id) {
              publishedContents = currentDraftContents;
            } else {
              const publishedRevision = await deps.getRevision(client, workflow.published_revision_id);
              if (!publishedRevision) {
                throw createHttpError(500, 'Published workflow revision could not be loaded');
              }

              publishedContents = await deps.readRevisionContents(publishedRevision);
            }
          }

          const saveTarget = deps.resolveManagedHostedProjectSaveTarget({
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
              project: deps.mapWorkflowRowToProjectItem(workflow),
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

              workflow = await deps.getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
              if (!workflow) {
                throw createHttpError(500, 'Saved workflow could not be loaded');
              }

              if (workflow.published_endpoint_name) {
                await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
              }
            }

            return {
              path: getManagedWorkflowProjectVirtualPath(workflow.relative_path),
              revisionId: publishedRevisionId,
              project: deps.mapWorkflowRowToProjectItem(workflow),
              created,
            };
          }
        } else {
          const existingIdOwner = await deps.getWorkflowById(client, workflowId);
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

        const revision = await deps.createRevision(workflowId, contents, options.datasetsContents);
        deps.scheduleRevisionBlobCleanup(hooks, revision);

        if (workflow) {
          await deps.insertRevision(client, revision);
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

          workflow = await deps.getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
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
          await deps.insertRevision(client, revision);

          workflow = await deps.getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
        }

        if (!workflow) {
          throw createHttpError(500, 'Saved workflow could not be loaded');
        }

        if (!created && workflow.published_endpoint_name) {
          await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
        }

        return {
          path: getManagedWorkflowProjectVirtualPath(workflow.relative_path),
          revisionId: revision.revision_id,
          project: deps.mapWorkflowRowToProjectItem(workflow),
          created,
        };
      });
    },

    async importWorkflow(options: ImportManagedWorkflowOptions) {
      const relativePath = normalizeManagedWorkflowRelativePath(options.relativePath, { allowProjectFile: true });
      const folderRelativePath = path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath);
      const fileName = options.fileName?.trim() || path.posix.basename(relativePath);
      const workflowName = options.name.trim() || path.posix.basename(relativePath, WORKFLOW_PROJECT_EXTENSION);
      const draftEndpointName = normalizeStoredEndpointName(options.endpointName);
      const publishedEndpointName = normalizeStoredEndpointName(options.publishedEndpointName);
      const updatedAt = options.updatedAt?.trim() || new Date().toISOString();
      const lastPublishedAt = options.lastPublishedAt?.trim() || null;

      return deps.withTransaction(async (client, hooks) => {
        await deps.ensureFolderChain(client, folderRelativePath);

        const existingByPath = await deps.getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
        if (existingByPath) {
          throw conflict(`Managed workflow already exists at ${relativePath}`);
        }

        const existingById = await deps.getWorkflowById(client, options.workflowId);
        if (existingById) {
          throw conflict(`Managed workflow id already exists: ${options.workflowId}`);
        }

        const draftRevision = await deps.createRevision(options.workflowId, options.contents, options.datasetsContents);
        deps.scheduleRevisionBlobCleanup(hooks, draftRevision);

        let publishedRevision: RevisionRow | null = null;
        let publishedRevisionId: string | null = null;
        const shouldCreateSeparatePublishedRevision = publishedEndpointName &&
          (options.publishedContents != null || options.publishedDatasetsContents != null) &&
          (options.publishedContents !== options.contents || options.publishedDatasetsContents !== options.datasetsContents);

        if (publishedEndpointName) {
          if (shouldCreateSeparatePublishedRevision) {
            publishedRevision = await deps.createRevision(
              options.workflowId,
              options.publishedContents ?? options.contents,
              options.publishedDatasetsContents ?? options.datasetsContents,
            );
            deps.scheduleRevisionBlobCleanup(hooks, publishedRevision);
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
        await deps.insertRevision(client, draftRevision);
        if (publishedRevision) {
          await deps.insertRevision(client, publishedRevision);
        }

        const workflow = await deps.getWorkflowById(client, options.workflowId);
        if (!workflow) {
          throw createHttpError(500, 'Imported workflow could not be loaded');
        }

        await deps.syncWorkflowEndpointRows(client, workflow, {
          draftEndpointName,
          publishedEndpointName,
        });

        if (publishedEndpointName) {
          await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
        }

        return deps.mapWorkflowRowToProjectItem(workflow);
      });
    },
  };
}
