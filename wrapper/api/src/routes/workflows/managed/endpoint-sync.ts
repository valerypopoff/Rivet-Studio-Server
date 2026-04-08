import type { PoolClient } from 'pg';

import { conflict } from '../../../utils/httpError.js';
import { normalizeWorkflowEndpointLookupName } from '../publication.js';
import { queryOne, queryRows } from './db.js';
import type { WorkflowRow } from './types.js';

export function createManagedWorkflowEndpointSync() {
  const getEndpointOwner = async (client: PoolClient, lookupName: string): Promise<{ workflow_id: string } | null> => queryOne<{ workflow_id: string }>(
    client,
    'SELECT workflow_id FROM workflow_endpoints WHERE lookup_name = $1',
    [lookupName],
  );

  return {
    async syncWorkflowEndpointRows(
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
        const owner = await getEndpointOwner(client, lookupName);
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
    },
  };
}
