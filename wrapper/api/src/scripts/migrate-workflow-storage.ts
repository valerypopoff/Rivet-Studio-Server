import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config as loadDotEnv } from 'dotenv';

import { loadProjectFromFile } from '@ironclad/rivet-node';

import type { WorkflowFolderItem, WorkflowProjectItem } from '../../../shared/workflow-types.js';
import type { WorkflowRecordingWorkflowSummary } from '../../../shared/workflow-recording-types.js';
import { listWorkflowFolders } from '../routes/workflows/workflow-query.js';
import { listProjectPathsRecursive, getWorkflowDatasetPath, pathExists, PROJECT_EXTENSION } from '../routes/workflows/fs-helpers.js';
import { readStoredWorkflowProjectSettings, resolvePublishedWorkflowProjectPath } from '../routes/workflows/publication.js';
import {
  initializeWorkflowRecordingStorage,
  listWorkflowRecordingRunsPage,
  listWorkflowRecordingWorkflows,
  readWorkflowRecordingArtifact,
} from '../routes/workflows/recordings.js';
import { getManagedWorkflowStorageConfig } from '../routes/workflows/storage-config.js';
import { ManagedWorkflowBackend } from '../routes/workflows/managed/backend.js';

type SourceWorkflow = {
  workflowId: string;
  relativePath: string;
  name: string;
  fileName: string;
  updatedAt: string;
  contents: string;
  datasetsContents: string | null;
  endpointName: string;
  publishedEndpointName: string;
  lastPublishedAt: string | null;
  publishedContents: string | null;
  publishedDatasetsContents: string | null;
};

type VerificationSummary = {
  sourceProjectCount: number;
  targetProjectCount: number;
  sourceFolderCount: number;
  targetFolderCount: number;
  sourceRecordingWorkflowCount: number;
  targetRecordingWorkflowCount: number;
};

function loadNearestEnvFile(startDir: string): void {
  let currentDir = path.resolve(startDir);

  while (true) {
    for (const fileName of ['.env', '.env.dev']) {
      const candidate = path.join(currentDir, fileName);
      if (existsSync(candidate)) {
        loadDotEnv({ path: candidate });
        return;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return;
    }

    currentDir = parentDir;
  }
}

loadNearestEnvFile(process.cwd());

function normalizeRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).replace(/\\/g, '/');
}

function getSourceRoot(): string {
  const cliSourceRoot = process.argv.find((arg) => arg.startsWith('--source-root='))?.slice('--source-root='.length);
  const envSourceRoot = process.env.RIVET_WORKFLOWS_MIGRATION_SOURCE_ROOT?.trim();
  const sourceRoot = cliSourceRoot?.trim() || envSourceRoot || process.env.RIVET_WORKFLOWS_ROOT?.trim();
  if (!sourceRoot) {
    throw new Error('Missing source workflows root. Set RIVET_WORKFLOWS_MIGRATION_SOURCE_ROOT or RIVET_WORKFLOWS_ROOT.');
  }

  return path.resolve(sourceRoot);
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  return await pathExists(filePath) ? await fs.readFile(filePath, 'utf8') : null;
}

async function collectSourceWorkflows(root: string): Promise<SourceWorkflow[]> {
  const projectPaths = await listProjectPathsRecursive(root);
  const workflows: SourceWorkflow[] = [];

  for (const projectPath of projectPaths) {
    const relativePath = normalizeRelativePath(root, projectPath);
    const fileName = path.basename(projectPath);
    const name = path.basename(projectPath, PROJECT_EXTENSION);
    const stats = await fs.stat(projectPath);
    const project = await loadProjectFromFile(projectPath);
    const settings = await readStoredWorkflowProjectSettings(projectPath, name);
    const publishedProjectPath = await resolvePublishedWorkflowProjectPath(root, projectPath, settings);

    workflows.push({
      workflowId: project.metadata.id ?? relativePath,
      relativePath,
      name,
      fileName,
      updatedAt: stats.mtime.toISOString(),
      contents: await fs.readFile(projectPath, 'utf8'),
      datasetsContents: await readOptionalUtf8(getWorkflowDatasetPath(projectPath)),
      endpointName: settings.endpointName,
      publishedEndpointName: settings.publishedEndpointName,
      lastPublishedAt: settings.lastPublishedAt,
      publishedContents: publishedProjectPath ? await fs.readFile(publishedProjectPath, 'utf8') : null,
      publishedDatasetsContents: publishedProjectPath
        ? await readOptionalUtf8(getWorkflowDatasetPath(publishedProjectPath))
        : null,
    });
  }

  workflows.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return workflows;
}

function flattenProjectsFromRecordingSummary(workflows: WorkflowRecordingWorkflowSummary[]) {
  return workflows
    .map((workflow) => ({
      relativePath: workflow.project.relativePath,
      totalRuns: workflow.totalRuns,
      failedRuns: workflow.failedRuns,
      suspiciousRuns: workflow.suspiciousRuns,
      latestRunAt: workflow.latestRunAt ?? null,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function compareProjectState(sourceProject: {
  relativePath: string;
  endpointName: string;
  lastPublishedAt: string | null;
  status: string;
}, targetProject: {
  relativePath: string;
  endpointName: string;
  lastPublishedAt: string | null;
  status: string;
}): boolean {
  return JSON.stringify(sourceProject) === JSON.stringify(targetProject);
}

async function importSourceWorkflows(root: string, backend: ManagedWorkflowBackend): Promise<Map<string, WorkflowProjectItem>> {
  const sourceWorkflows = await collectSourceWorkflows(root);
  const importedProjects = new Map<string, WorkflowProjectItem>();

  for (const workflow of sourceWorkflows) {
    const importedProject = await backend.importWorkflow({
      workflowId: workflow.workflowId,
      relativePath: workflow.relativePath,
      name: workflow.name,
      fileName: workflow.fileName,
      updatedAt: workflow.updatedAt,
      contents: workflow.contents,
      datasetsContents: workflow.datasetsContents,
      endpointName: workflow.endpointName,
      publishedEndpointName: workflow.publishedEndpointName,
      lastPublishedAt: workflow.lastPublishedAt,
      publishedContents: workflow.publishedContents,
      publishedDatasetsContents: workflow.publishedDatasetsContents,
    });

    importedProjects.set(workflow.relativePath, importedProject);
    console.log(`[workflow-storage:migrate] Imported workflow ${workflow.relativePath}`);
  }

  return importedProjects;
}

async function importSourceRecordings(root: string, backend: ManagedWorkflowBackend, importedProjects: Map<string, WorkflowProjectItem>): Promise<void> {
  await initializeWorkflowRecordingStorage(root);
  const sourceRecordingWorkflows = await listWorkflowRecordingWorkflows(root);

  for (const sourceWorkflow of sourceRecordingWorkflows.workflows) {
    const relativePath = sourceWorkflow.project.relativePath;
    const importedProject = importedProjects.get(relativePath);
    if (!importedProject) {
      console.warn(`[workflow-storage:migrate] Skipping recordings for ${relativePath} because the workflow was not imported.`);
      continue;
    }

    let page = 1;
    const pageSize = 100;
    while (true) {
      const runsPage = await listWorkflowRecordingRunsPage(root, sourceWorkflow.workflowId, page, pageSize, 'all');
      for (const run of runsPage.runs) {
        const recordingContents = await readWorkflowRecordingArtifact(root, run.id, 'recording');
        const replayProjectContents = await readWorkflowRecordingArtifact(root, run.id, 'replay-project');
        const replayDatasetContents = run.hasReplayDataset
          ? await readWorkflowRecordingArtifact(root, run.id, 'replay-dataset')
          : null;

        await backend.importWorkflowRecording({
          recordingId: run.id,
          workflowId: importedProject.id,
          sourceProjectRelativePath: relativePath,
          sourceProjectName: sourceWorkflow.project.name,
          createdAt: run.createdAt,
          runKind: run.runKind,
          status: run.status,
          durationMs: run.durationMs,
          endpointName: run.endpointNameAtExecution,
          errorMessage: run.errorMessage,
          recordingContents,
          replayProjectContents,
          replayDatasetContents,
        });
      }

      if (page * pageSize >= runsPage.totalRuns) {
        break;
      }

      page += 1;
    }

    if (sourceWorkflow.totalRuns > 0) {
      console.log(`[workflow-storage:migrate] Imported ${sourceWorkflow.totalRuns} recordings for ${relativePath}`);
    }
  }
}

function deriveSourceWorkflowStatus(workflow: SourceWorkflow): 'unpublished' | 'published' | 'unpublished_changes' {
  if (!workflow.publishedEndpointName) {
    return 'unpublished';
  }

  return workflow.publishedContents === workflow.contents &&
    workflow.publishedDatasetsContents === workflow.datasetsContents &&
    workflow.publishedEndpointName.toLowerCase() === workflow.endpointName.toLowerCase()
    ? 'published'
    : 'unpublished_changes';
}

function flattenProjects(projects: WorkflowProjectItem[], folders: WorkflowFolderItem[]): WorkflowProjectItem[] {
  const flattenedProjects = [...projects];
  const visit = (items: WorkflowFolderItem[]) => {
    for (const folder of items) {
      flattenedProjects.push(...folder.projects);
      visit(folder.folders);
    }
  };

  visit(folders);
  return flattenedProjects;
}

function collectFolderPaths(folders: WorkflowFolderItem[]): string[] {
  const paths: string[] = [];
  const visit = (items: WorkflowFolderItem[]) => {
    for (const folder of items) {
      paths.push(folder.relativePath);
      visit(folder.folders);
    }
  };

  visit(folders);
  return paths.sort((left, right) => left.localeCompare(right));
}

async function verifyMigration(root: string, backend: ManagedWorkflowBackend): Promise<VerificationSummary> {
  const [sourceFolders, sourceWorkflows, sourceRecordingWorkflows, targetTree, targetRecordingWorkflows] = await Promise.all([
    listWorkflowFolders(root),
    collectSourceWorkflows(root),
    listWorkflowRecordingWorkflows(root),
    backend.getTree(),
    backend.listWorkflowRecordingWorkflows(),
  ]);

  const sourceFolderPaths = collectFolderPaths(sourceFolders);
  const targetFolderPaths = collectFolderPaths(targetTree.folders);
  const sourceProjectState = sourceWorkflows.map((workflow) => ({
    relativePath: workflow.relativePath,
    endpointName: workflow.endpointName,
    lastPublishedAt: workflow.lastPublishedAt,
    status: deriveSourceWorkflowStatus(workflow),
  })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const targetProjectState = flattenProjects(targetTree.projects, targetTree.folders)
    .map((project) => ({
      relativePath: project.relativePath,
      endpointName: project.settings.endpointName,
      lastPublishedAt: project.settings.lastPublishedAt,
      status: project.settings.status,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const targetFolderPathSet = new Set(targetFolderPaths);
  for (const sourceFolderPath of sourceFolderPaths) {
    if (!targetFolderPathSet.has(sourceFolderPath)) {
      throw new Error(`Managed workflow folder is missing: ${sourceFolderPath}`);
    }
  }

  const sourceRecordingState = flattenProjectsFromRecordingSummary(sourceRecordingWorkflows.workflows);
  const targetRecordingState = flattenProjectsFromRecordingSummary(targetRecordingWorkflows.workflows);

  const targetProjectStateByRelativePath = new Map(targetProjectState.map((project) => [project.relativePath, project]));
  for (const sourceProject of sourceProjectState) {
    const targetProject = targetProjectStateByRelativePath.get(sourceProject.relativePath);
    if (!targetProject) {
      throw new Error(`Managed workflow is missing: ${sourceProject.relativePath}`);
    }

    if (!compareProjectState(sourceProject, targetProject)) {
      throw new Error(`Managed workflow mismatch for ${sourceProject.relativePath}`);
    }
  }

  const targetRecordingStateByRelativePath = new Map(targetRecordingState.map((workflow) => [workflow.relativePath, workflow]));
  for (const sourceRecording of sourceRecordingState) {
    const targetRecording = targetRecordingStateByRelativePath.get(sourceRecording.relativePath);
    if (!targetRecording) {
      throw new Error(`Managed recording summary is missing: ${sourceRecording.relativePath}`);
    }

    if (targetRecording.totalRuns < sourceRecording.totalRuns) {
      throw new Error(`Managed recording count regressed for ${sourceRecording.relativePath}`);
    }

    if (targetRecording.failedRuns < sourceRecording.failedRuns) {
      throw new Error(`Managed failed recording count regressed for ${sourceRecording.relativePath}`);
    }

    if (targetRecording.suspiciousRuns < sourceRecording.suspiciousRuns) {
      throw new Error(`Managed suspicious recording count regressed for ${sourceRecording.relativePath}`);
    }

    if (sourceRecording.latestRunAt && (!targetRecording.latestRunAt || targetRecording.latestRunAt < sourceRecording.latestRunAt)) {
      throw new Error(`Managed latest recording timestamp regressed for ${sourceRecording.relativePath}`);
    }
  }

  return {
    sourceProjectCount: sourceProjectState.length,
    targetProjectCount: targetProjectState.length,
    sourceFolderCount: sourceFolderPaths.length,
    targetFolderCount: targetFolderPaths.length,
    sourceRecordingWorkflowCount: sourceRecordingState.length,
    targetRecordingWorkflowCount: targetRecordingState.length,
  };
}

async function main() {
  const mode = process.argv[2] === 'verify' ? 'verify' : 'migrate';
  const sourceRoot = getSourceRoot();
  const backend = new ManagedWorkflowBackend(getManagedWorkflowStorageConfig());

  try {
    console.log(`[workflow-storage:${mode}] Initializing managed backend...`);
    await backend.initialize();
    console.log(`[workflow-storage:${mode}] Managed backend ready.`);

    if (mode === 'migrate') {
      console.log(`[workflow-storage:${mode}] Importing workflows from ${sourceRoot}...`);
      const importedProjects = await importSourceWorkflows(sourceRoot, backend);
      console.log(`[workflow-storage:${mode}] Importing recordings...`);
      await importSourceRecordings(sourceRoot, backend, importedProjects);
    }

    console.log(`[workflow-storage:${mode}] Verifying managed state...`);
    const summary = await verifyMigration(sourceRoot, backend);
    console.log(`[workflow-storage:${mode}] Verified ${summary.targetProjectCount} workflows, ${summary.targetFolderCount} folders, and ${summary.targetRecordingWorkflowCount} recording workflow summaries.`);
  } finally {
    await backend.dispose();
  }
}

main().catch((error) => {
  console.error('[workflow-storage] Migration failed:', error);
  process.exit(1);
});
