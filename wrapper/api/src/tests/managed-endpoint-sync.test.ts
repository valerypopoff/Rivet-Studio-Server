import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';

import { createManagedWorkflowEndpointSync } from '../routes/workflows/managed/endpoint-sync.js';
import type { WorkflowRow } from '../routes/workflows/managed/types.js';

type EndpointRow = {
  lookup_name: string;
  workflow_id: string;
  endpoint_name: string;
  is_draft: boolean;
  is_published: boolean;
};

class FakeEndpointSyncClient {
  readonly endpointRows = new Map<string, EndpointRow>();

  seed(row: EndpointRow): void {
    this.endpointRows.set(row.lookup_name, row);
  }

  async query(text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
    const sql = text.replace(/\s+/g, ' ').trim();

    if (sql === 'SELECT workflow_id FROM workflow_endpoints WHERE lookup_name = $1') {
      const lookupName = String(values[0] ?? '');
      const row = this.endpointRows.get(lookupName);
      return {
        rows: row ? [{ workflow_id: row.workflow_id }] : [],
      };
    }

    if (sql === 'SELECT lookup_name FROM workflow_endpoints WHERE workflow_id = $1') {
      const workflowId = String(values[0] ?? '');
      return {
        rows: [...this.endpointRows.values()]
          .filter((row) => row.workflow_id === workflowId)
          .map((row) => ({ lookup_name: row.lookup_name })),
      };
    }

    if (sql.includes('INSERT INTO workflow_endpoints')) {
      const [lookupName, workflowId, endpointName, isDraft, isPublished] = values as [
        string,
        string,
        string,
        boolean,
        boolean,
      ];
      this.endpointRows.set(lookupName, {
        lookup_name: lookupName,
        workflow_id: workflowId,
        endpoint_name: endpointName,
        is_draft: isDraft,
        is_published: isPublished,
      });
      return { rows: [] };
    }

    if (sql === 'DELETE FROM workflow_endpoints WHERE workflow_id = $1') {
      const workflowId = String(values[0] ?? '');
      for (const [lookupName, row] of this.endpointRows.entries()) {
        if (row.workflow_id === workflowId) {
          this.endpointRows.delete(lookupName);
        }
      }
      return { rows: [] };
    }

    if (sql === 'DELETE FROM workflow_endpoints WHERE workflow_id = $1 AND lookup_name <> ALL($2::text[])') {
      const workflowId = String(values[0] ?? '');
      const desiredLookupNames = new Set((values[1] as string[]) ?? []);
      for (const [lookupName, row] of this.endpointRows.entries()) {
        if (row.workflow_id === workflowId && !desiredLookupNames.has(lookupName)) {
          this.endpointRows.delete(lookupName);
        }
      }
      return { rows: [] };
    }

    if (sql === 'DELETE FROM workflow_endpoints WHERE lookup_name = $1 AND workflow_id = $2') {
      const lookupName = String(values[0] ?? '');
      const workflowId = String(values[1] ?? '');
      const row = this.endpointRows.get(lookupName);
      if (row?.workflow_id === workflowId) {
        this.endpointRows.delete(lookupName);
      }
      return { rows: [] };
    }

    throw new Error(`Unhandled SQL in fake endpoint client: ${sql}`);
  }
}

function createWorkflowRow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    workflow_id: 'workflow-a',
    name: 'Main',
    file_name: 'Main.rivet-project',
    relative_path: 'Main.rivet-project',
    folder_relative_path: '',
    updated_at: new Date().toISOString(),
    current_draft_revision_id: 'revision-a',
    published_revision_id: 'revision-a',
    endpoint_name: '',
    published_endpoint_name: '',
    last_published_at: null,
    ...overrides,
  };
}

test('draft and published endpoint names with the same normalized lookup collapse to one row', async () => {
  const client = new FakeEndpointSyncClient();
  const endpointSync = createManagedWorkflowEndpointSync();

  await endpointSync.syncWorkflowEndpointRows(
    client as unknown as PoolClient,
    createWorkflowRow(),
    {
      draftEndpointName: 'Hello-World',
      publishedEndpointName: 'hello-world',
    },
  );

  assert.equal(client.endpointRows.size, 1);
  assert.deepEqual(client.endpointRows.get('hello-world'), {
    lookup_name: 'hello-world',
    workflow_id: 'workflow-a',
    endpoint_name: 'hello-world',
    is_draft: true,
    is_published: true,
  });
});

test('normalized endpoint conflicts throw a 409', async () => {
  const client = new FakeEndpointSyncClient();
  client.seed({
    lookup_name: 'hello-world',
    workflow_id: 'workflow-b',
    endpoint_name: 'hello-world',
    is_draft: false,
    is_published: true,
  });

  const endpointSync = createManagedWorkflowEndpointSync();

  await assert.rejects(
    endpointSync.syncWorkflowEndpointRows(
      client as unknown as PoolClient,
      createWorkflowRow(),
      {
        draftEndpointName: 'Hello-World',
        publishedEndpointName: '',
      },
    ),
    (error: unknown) => {
      assert.equal(typeof error, 'object');
      assert.equal((error as { status?: number }).status, 409);
      assert.match(String((error as Error).message), /already used by another workflow/);
      return true;
    },
  );
});

test('removing all desired endpoints deletes all rows owned by the workflow', async () => {
  const client = new FakeEndpointSyncClient();
  client.seed({
    lookup_name: 'hello-world',
    workflow_id: 'workflow-a',
    endpoint_name: 'hello-world',
    is_draft: true,
    is_published: false,
  });
  client.seed({
    lookup_name: 'main-live',
    workflow_id: 'workflow-a',
    endpoint_name: 'main-live',
    is_draft: false,
    is_published: true,
  });

  const endpointSync = createManagedWorkflowEndpointSync();

  await endpointSync.syncWorkflowEndpointRows(
    client as unknown as PoolClient,
    createWorkflowRow(),
    {
      draftEndpointName: '',
      publishedEndpointName: '',
    },
  );

  assert.deepEqual(
    [...client.endpointRows.values()].filter((row) => row.workflow_id === 'workflow-a'),
    [],
  );
});

test('distinct draft and published endpoints preserve their own visibility flags', async () => {
  const client = new FakeEndpointSyncClient();
  const endpointSync = createManagedWorkflowEndpointSync();

  await endpointSync.syncWorkflowEndpointRows(
    client as unknown as PoolClient,
    createWorkflowRow(),
    {
      draftEndpointName: 'latest-only',
      publishedEndpointName: 'public-live',
    },
  );

  assert.deepEqual(client.endpointRows.get('latest-only'), {
    lookup_name: 'latest-only',
    workflow_id: 'workflow-a',
    endpoint_name: 'latest-only',
    is_draft: true,
    is_published: false,
  });
  assert.deepEqual(client.endpointRows.get('public-live'), {
    lookup_name: 'public-live',
    workflow_id: 'workflow-a',
    endpoint_name: 'public-live',
    is_draft: false,
    is_published: true,
  });
});
