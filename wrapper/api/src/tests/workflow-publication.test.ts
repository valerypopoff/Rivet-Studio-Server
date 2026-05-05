import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createWorkflowTestRoots, resetWorkflowTestRoots } from './helpers/workflow-fixtures.js';

const {
  tempRoot,
  workflowsRoot,
  appDataRoot,
} = await createWorkflowTestRoots('rivet-workflow-publication-');

const workflowFs = await import('../routes/workflows/fs-helpers.js');
const workflowPublication = await import('../routes/workflows/publication.js');
type StoredWorkflowProjectSettings = Awaited<ReturnType<typeof workflowPublication.readStoredWorkflowProjectSettings>>;

async function resetFilesystemRoots(): Promise<void> {
  await resetWorkflowTestRoots({ workflowsRoot, appDataRoot });
}

async function writeBlankProject(projectName: string): Promise<string> {
  const projectPath = path.join(workflowsRoot, `${projectName}.rivet-project`);
  await fs.writeFile(projectPath, workflowFs.createBlankProjectFile(projectName), 'utf8');
  return projectPath;
}

async function writeSettings(
  projectPath: string,
  settings: Partial<StoredWorkflowProjectSettings>,
): Promise<void> {
  await workflowPublication.writeStoredWorkflowProjectSettings(projectPath, {
    endpointName: '',
    publishedEndpointName: '',
    publishedSnapshotId: null,
    publishedStateHash: null,
    lastPublishedAt: null,
    ...settings,
  });
}

test.beforeEach(async () => {
  await resetFilesystemRoots();
});

test.after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('fully unpublished draft endpoint names do not reserve filesystem endpoints', async () => {
  const previousProjectPath = await writeBlankProject('PreviousEndpointOwner');
  const nextProjectPath = await writeBlankProject('NextEndpointOwner');

  await writeSettings(previousProjectPath, {
    endpointName: 'reusable-endpoint',
    lastPublishedAt: '2026-05-05T00:00:00.000Z',
  });

  await assert.doesNotReject(
    workflowPublication.ensureWorkflowEndpointNameIsUnique(
      workflowsRoot,
      nextProjectPath,
      'Reusable-Endpoint',
    ),
  );

  await writeSettings(nextProjectPath, {
    endpointName: 'Reusable-Endpoint',
    publishedEndpointName: 'Reusable-Endpoint',
    publishedSnapshotId: 'next-snapshot',
    publishedStateHash: await workflowPublication.createWorkflowPublicationStateHash(
      nextProjectPath,
      'Reusable-Endpoint',
    ),
    lastPublishedAt: '2026-05-05T00:01:00.000Z',
  });

  await assert.rejects(
    workflowPublication.ensureWorkflowEndpointNameIsUnique(
      workflowsRoot,
      previousProjectPath,
      'reusable-endpoint',
    ),
    /Endpoint name is already used by NextEndpointOwner\.rivet-project/,
  );
});

test('active draft and published endpoint identities both reserve filesystem endpoints', async () => {
  const activeProjectPath = await writeBlankProject('ActiveEndpointOwner');
  const otherProjectPath = await writeBlankProject('OtherEndpointOwner');

  await writeSettings(activeProjectPath, {
    endpointName: 'current-draft-endpoint',
    publishedEndpointName: 'published-endpoint',
    publishedSnapshotId: 'active-snapshot',
    publishedStateHash: await workflowPublication.createWorkflowPublicationStateHash(
      activeProjectPath,
      'published-endpoint',
    ),
    lastPublishedAt: '2026-05-05T00:02:00.000Z',
  });

  await assert.rejects(
    workflowPublication.ensureWorkflowEndpointNameIsUnique(
      workflowsRoot,
      otherProjectPath,
      'Current-Draft-Endpoint',
    ),
    /Endpoint name is already used by ActiveEndpointOwner\.rivet-project/,
  );

  await assert.rejects(
    workflowPublication.ensureWorkflowEndpointNameIsUnique(
      workflowsRoot,
      otherProjectPath,
      'Published-Endpoint',
    ),
    /Endpoint name is already used by ActiveEndpointOwner\.rivet-project/,
  );
});
