import { Router } from 'express';
import { z } from 'zod';

import { validateBody } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest } from '../../utils/httpError.js';
import {
  ensureWorkflowsRoot,
  PROJECT_EXTENSION,
} from './fs-helpers.js';
import { internalPublishedWorkflowsRouter, latestWorkflowsRouter, publishedWorkflowsRouter } from './execution.js';
import {
  deleteWorkflowRecording,
  listWorkflowRecordingRunsPage,
  listWorkflowRecordingWorkflows,
  readWorkflowRecordingArtifact,
} from './recordings.js';
import { listWorkflowFolders, listWorkflowProjects, moveWorkflowFolder, moveWorkflowProject } from './workflow-query.js';
import {
  createWorkflowFolderItem,
  createWorkflowProjectItem,
  deleteWorkflowFolderItem,
  deleteWorkflowProjectItem,
  duplicateWorkflowProjectItem,
  publishWorkflowProjectItem,
  renameWorkflowFolderItem,
  renameWorkflowProjectItem,
  unpublishWorkflowProjectItem,
} from './workflow-mutations.js';
import { createWorkflowDownloadContentDisposition, readWorkflowProjectDownload } from './workflow-download.js';

export const workflowsRouter = Router();

const moveSchema = z.object({
  itemType: z.enum(['project', 'folder']),
  sourceRelativePath: z.unknown(),
  destinationFolderRelativePath: z.unknown().optional(),
});

const createFolderSchema = z.object({
  name: z.unknown(),
  parentRelativePath: z.unknown().optional(),
});

const renameFolderSchema = z.object({
  relativePath: z.unknown(),
  newName: z.unknown(),
});

const deleteFolderSchema = z.object({
  relativePath: z.unknown(),
});

const createProjectSchema = z.object({
  folderRelativePath: z.unknown().optional(),
  name: z.unknown(),
});

const renameProjectSchema = z.object({
  relativePath: z.unknown(),
  newName: z.unknown(),
});

const publishProjectSchema = z.object({
  relativePath: z.unknown(),
  settings: z.unknown().optional(),
});

const pathOnlySchema = z.object({
  relativePath: z.unknown(),
});

const downloadProjectSchema = z.object({
  relativePath: z.unknown(),
  version: z.enum(['live', 'published']),
});

const recordingsRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: z.enum(['all', 'failed']).optional().default('all'),
});

workflowsRouter.get('/tree', asyncHandler(async (_req, res) => {
  const root = await ensureWorkflowsRoot();
  const folders = await listWorkflowFolders(root);
  const projects = await listWorkflowProjects(root);
  res.json({ root, folders, projects });
}));

workflowsRouter.get('/recordings', asyncHandler(async (_req, res) => {
  const root = await ensureWorkflowsRoot();
  res.json(await listWorkflowRecordingWorkflows(root));
}));

workflowsRouter.get('/recordings/workflows', asyncHandler(async (_req, res) => {
  const root = await ensureWorkflowsRoot();
  res.json(await listWorkflowRecordingWorkflows(root));
}));

workflowsRouter.get('/recordings/workflows/:workflowId/runs', asyncHandler(async (req, res) => {
  const root = await ensureWorkflowsRoot();
  const parsedQuery = recordingsRunsQuerySchema.parse(req.query);
  res.json(await listWorkflowRecordingRunsPage(
    root,
    String(req.params.workflowId ?? ''),
    parsedQuery.page,
    parsedQuery.pageSize,
    parsedQuery.status,
  ));
}));

workflowsRouter.get('/recordings/:recordingId/recording', asyncHandler(async (req, res) => {
  const root = await ensureWorkflowsRoot();
  res.type('text/plain; charset=utf-8').send(await readWorkflowRecordingArtifact(
    root,
    String(req.params.recordingId ?? ''),
    'recording',
  ));
}));

workflowsRouter.get('/recordings/:recordingId/replay-project', asyncHandler(async (req, res) => {
  const root = await ensureWorkflowsRoot();
  res.type('text/plain; charset=utf-8').send(await readWorkflowRecordingArtifact(
    root,
    String(req.params.recordingId ?? ''),
    'replay-project',
  ));
}));

workflowsRouter.get('/recordings/:recordingId/replay-dataset', asyncHandler(async (req, res) => {
  const root = await ensureWorkflowsRoot();
  res.type('text/plain; charset=utf-8').send(await readWorkflowRecordingArtifact(
    root,
    String(req.params.recordingId ?? ''),
    'replay-dataset',
  ));
}));

workflowsRouter.delete('/recordings/:recordingId', asyncHandler(async (req, res) => {
  const root = await ensureWorkflowsRoot();
  await deleteWorkflowRecording(root, String(req.params.recordingId ?? ''));
  res.json({ deleted: true });
}));

workflowsRouter.post('/move', validateBody(moveSchema), asyncHandler(async (req, res) => {
  const { itemType, sourceRelativePath, destinationFolderRelativePath } = req.body as z.infer<typeof moveSchema>;
  const root = await ensureWorkflowsRoot();

  if (itemType === 'project') {
    res.json(await moveWorkflowProject(root, sourceRelativePath, destinationFolderRelativePath));
    return;
  }

  if (itemType === 'folder') {
    res.json(await moveWorkflowFolder(root, sourceRelativePath, destinationFolderRelativePath));
    return;
  }

  throw badRequest('Invalid itemType');
}));

workflowsRouter.post('/folders', validateBody(createFolderSchema), asyncHandler(async (req, res) => {
  const { name, parentRelativePath } = req.body as z.infer<typeof createFolderSchema>;
  const folder = await createWorkflowFolderItem(name, parentRelativePath);
  res.status(201).json({ folder });
}));

workflowsRouter.patch('/folders', validateBody(renameFolderSchema), asyncHandler(async (req, res) => {
  const { relativePath, newName } = req.body as z.infer<typeof renameFolderSchema>;
  const folder = await renameWorkflowFolderItem(relativePath, newName);
  res.json({ folder });
}));

workflowsRouter.delete('/folders', validateBody(deleteFolderSchema), asyncHandler(async (req, res) => {
  const { relativePath } = req.body as z.infer<typeof deleteFolderSchema>;
  await deleteWorkflowFolderItem(relativePath);
  res.json({ deleted: true });
}));

workflowsRouter.post('/projects', validateBody(createProjectSchema), asyncHandler(async (req, res) => {
  const { folderRelativePath, name } = req.body as z.infer<typeof createProjectSchema>;
  const project = await createWorkflowProjectItem(folderRelativePath, name);
  res.status(201).json({ project });
}));

workflowsRouter.patch('/projects', validateBody(renameProjectSchema), asyncHandler(async (req, res) => {
  const { relativePath, newName } = req.body as z.infer<typeof renameProjectSchema>;
  res.json(await renameWorkflowProjectItem(relativePath, newName));
}));

workflowsRouter.post('/projects/duplicate', validateBody(pathOnlySchema), asyncHandler(async (req, res) => {
  const { relativePath } = req.body as z.infer<typeof pathOnlySchema>;
  res.status(201).json({ project: await duplicateWorkflowProjectItem(relativePath) });
}));

workflowsRouter.post('/projects/download', validateBody(downloadProjectSchema), asyncHandler(async (req, res) => {
  const { relativePath, version } = req.body as z.infer<typeof downloadProjectSchema>;
  const download = await readWorkflowProjectDownload(relativePath, version);
  res.setHeader('Content-Type', 'application/x-yaml; charset=utf-8');
  res.setHeader('Content-Disposition', createWorkflowDownloadContentDisposition(download.fileName));
  res.status(200).send(download.contents);
}));

workflowsRouter.post('/projects/publish', validateBody(publishProjectSchema), asyncHandler(async (req, res) => {
  const { relativePath, settings } = req.body as z.infer<typeof publishProjectSchema>;
  res.json({ project: await publishWorkflowProjectItem(relativePath, settings) });
}));

workflowsRouter.post('/projects/unpublish', validateBody(pathOnlySchema), asyncHandler(async (req, res) => {
  const { relativePath } = req.body as z.infer<typeof pathOnlySchema>;
  res.json({ project: await unpublishWorkflowProjectItem(relativePath) });
}));

workflowsRouter.delete('/projects', validateBody(pathOnlySchema), asyncHandler(async (req, res) => {
  const { relativePath } = req.body as z.infer<typeof pathOnlySchema>;
  await deleteWorkflowProjectItem(relativePath);
  res.json({ deleted: true });
}));

export { internalPublishedWorkflowsRouter, latestWorkflowsRouter, publishedWorkflowsRouter };
export type {
  LatestWorkflowMatch,
  PublishedWorkflowMatch,
  StoredWorkflowProjectSettings,
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettings,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
} from './types.js';
