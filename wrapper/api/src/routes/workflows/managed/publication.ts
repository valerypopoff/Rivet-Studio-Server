import { type PoolClient } from 'pg';

import type { WorkflowProjectItem, WorkflowProjectSettingsDraft } from '../../../../../shared/workflow-types.js';
import { badRequest, createHttpError } from '../../../utils/httpError.js';
import { normalizeStoredEndpointName } from '../publication.js';
import { normalizeManagedWorkflowRelativePath } from '../virtual-paths.js';
import type { ManagedWorkflowContext } from './context.js';
import type { TransactionHooks, WorkflowRow } from './types.js';

type ManagedWorkflowPublicationServiceDependencies = {
  context: ManagedWorkflowContext;
};

export function createManagedWorkflowPublicationService(options: ManagedWorkflowPublicationServiceDependencies) {
  const deps = {
    withTransaction: options.context.withTransaction,
    getWorkflowByRelativePath: options.context.queries.getWorkflowByRelativePath,
    syncWorkflowEndpointRows: options.context.endpointSync.syncWorkflowEndpointRows,
    mapWorkflowRowToProjectItem: options.context.mappers.mapWorkflowRowToProjectItem,
    queueWorkflowInvalidation: options.context.executionInvalidationController.queueWorkflowInvalidation.bind(options.context.executionInvalidationController),
  };

  return {
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

      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        await deps.syncWorkflowEndpointRows(client, workflow, {
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

        const publishedWorkflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!publishedWorkflow) {
          throw createHttpError(500, 'Published workflow could not be loaded');
        }

        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);

        return deps.mapWorkflowRowToProjectItem(publishedWorkflow);
      });
    },

    async unpublishWorkflowProjectItem(relativePath: unknown): Promise<WorkflowProjectItem> {
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });

      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
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

        await deps.syncWorkflowEndpointRows(client, workflow, {
          draftEndpointName: workflow.endpoint_name,
          publishedEndpointName: '',
        });

        const unpublishedWorkflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!unpublishedWorkflow) {
          throw createHttpError(500, 'Unpublished workflow could not be loaded');
        }

        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);

        return deps.mapWorkflowRowToProjectItem(unpublishedWorkflow);
      });
    },
  };
}
