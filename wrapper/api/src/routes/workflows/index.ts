import { Router } from 'express';
import { z } from 'zod';

import { validateBody } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest } from '../../utils/httpError.js';
import { createResponseTimingMiddleware } from '../../utils/responseTiming.js';
import {
  PROJECT_EXTENSION,
} from './fs-helpers.js';
import { internalPublishedWorkflowsRouter, latestWorkflowsRouter, publishedWorkflowsRouter } from './execution.js';
import {
  createWorkflowFolderItemWithBackend,
  createWorkflowProjectItemWithBackend,
  deleteWorkflowFolderItemWithBackend,
  deleteWorkflowProjectItemWithBackend,
  deleteWorkflowRecordingWithBackend,
  duplicateWorkflowProjectItemWithBackend,
  getWorkflowTree,
  listWorkflowRecordingRunsPageWithBackend,
  listWorkflowRecordingWorkflowsWithBackend,
  moveWorkflowItemWithBackend,
  publishWorkflowProjectItemWithBackend,
  readWorkflowProjectDownloadWithBackend,
  readWorkflowRecordingArtifactWithBackend,
  renameWorkflowFolderItemWithBackend,
  renameWorkflowProjectItemWithBackend,
  unpublishWorkflowProjectItemWithBackend,
  uploadWorkflowProjectItemWithBackend,
} from './storage-backend.js';
import { createWorkflowDownloadContentDisposition } from './workflow-download.js';

export const workflowsRouter = Router();
const timing = createResponseTimingMiddleware();

workflowsRouter.use((req, res, next) => {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }

  next();
});

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

const uploadProjectSchema = z.object({
  folderRelativePath: z.unknown().optional(),
  fileName: z.unknown(),
  contents: z.unknown(),
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

const duplicateProjectSchema = z.object({
  relativePath: z.unknown(),
  version: z.enum(['live', 'published']).optional(),
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

workflowsRouter.get('/tree', timing, asyncHandler(async (_req, res) => {
  res.json(await getWorkflowTree());
}));

workflowsRouter.get('/recordings', asyncHandler(async (_req, res) => {
  res.json(await listWorkflowRecordingWorkflowsWithBackend());
}));

workflowsRouter.get('/recordings/workflows', asyncHandler(async (_req, res) => {
  res.json(await listWorkflowRecordingWorkflowsWithBackend());
}));

workflowsRouter.get('/recordings/workflows/:workflowId/runs', asyncHandler(async (req, res) => {
  const parsedQuery = recordingsRunsQuerySchema.parse(req.query);
  res.json(await listWorkflowRecordingRunsPageWithBackend(
    String(req.params.workflowId ?? ''),
    parsedQuery.page,
    parsedQuery.pageSize,
    parsedQuery.status,
  ));
}));

workflowsRouter.get('/recordings/:recordingId/recording', asyncHandler(async (req, res) => {
  res.type('text/plain; charset=utf-8').send(await readWorkflowRecordingArtifactWithBackend(
    String(req.params.recordingId ?? ''),
    'recording',
  ));
}));

workflowsRouter.get('/recordings/:recordingId/replay-project', asyncHandler(async (req, res) => {
  res.type('text/plain; charset=utf-8').send(await readWorkflowRecordingArtifactWithBackend(
    String(req.params.recordingId ?? ''),
    'replay-project',
  ));
}));

workflowsRouter.get('/recordings/:recordingId/replay-dataset', asyncHandler(async (req, res) => {
  res.type('text/plain; charset=utf-8').send(await readWorkflowRecordingArtifactWithBackend(
    String(req.params.recordingId ?? ''),
    'replay-dataset',
  ));
}));

workflowsRouter.delete('/recordings/:recordingId', asyncHandler(async (req, res) => {
  await deleteWorkflowRecordingWithBackend(String(req.params.recordingId ?? ''));
  res.json({ deleted: true });
}));

workflowsRouter.post('/move', validateBody(moveSchema), asyncHandler(async (req, res) => {
  const { itemType, sourceRelativePath, destinationFolderRelativePath } = req.body as z.infer<typeof moveSchema>;
  if (itemType === 'project' || itemType === 'folder') {
    res.json(await moveWorkflowItemWithBackend(itemType, sourceRelativePath, destinationFolderRelativePath));
    return;
  }

  throw badRequest('Invalid itemType');
}));

workflowsRouter.post('/folders', validateBody(createFolderSchema), asyncHandler(async (req, res) => {
  const { name, parentRelativePath } = req.body as z.infer<typeof createFolderSchema>;
  const folder = await createWorkflowFolderItemWithBackend(name, parentRelativePath);
  res.status(201).json({ folder });
}));

workflowsRouter.patch('/folders', timing, validateBody(renameFolderSchema), asyncHandler(async (req, res) => {
  const { relativePath, newName } = req.body as z.infer<typeof renameFolderSchema>;
  res.json(await renameWorkflowFolderItemWithBackend(relativePath, newName));
}));

workflowsRouter.delete('/folders', validateBody(deleteFolderSchema), asyncHandler(async (req, res) => {
  const { relativePath } = req.body as z.infer<typeof deleteFolderSchema>;
  await deleteWorkflowFolderItemWithBackend(relativePath);
  res.json({ deleted: true });
}));

workflowsRouter.post('/projects', validateBody(createProjectSchema), asyncHandler(async (req, res) => {
  const { folderRelativePath, name } = req.body as z.infer<typeof createProjectSchema>;
  const project = await createWorkflowProjectItemWithBackend(folderRelativePath, name);
  res.status(201).json({ project });
}));

workflowsRouter.patch('/projects', validateBody(renameProjectSchema), asyncHandler(async (req, res) => {
  const { relativePath, newName } = req.body as z.infer<typeof renameProjectSchema>;
  res.json(await renameWorkflowProjectItemWithBackend(relativePath, newName));
}));

workflowsRouter.post('/projects/duplicate', validateBody(duplicateProjectSchema), asyncHandler(async (req, res) => {
  const { relativePath, version } = req.body as z.infer<typeof duplicateProjectSchema>;
  res.status(201).json({ project: await duplicateWorkflowProjectItemWithBackend(relativePath, version ?? 'live') });
}));

workflowsRouter.post('/projects/upload', validateBody(uploadProjectSchema), asyncHandler(async (req, res) => {
  const { folderRelativePath, fileName, contents } = req.body as z.infer<typeof uploadProjectSchema>;
  res.status(201).json({ project: await uploadWorkflowProjectItemWithBackend(folderRelativePath, fileName, contents) });
}));

workflowsRouter.post('/projects/download', validateBody(downloadProjectSchema), asyncHandler(async (req, res) => {
  const { relativePath, version } = req.body as z.infer<typeof downloadProjectSchema>;
  const download = await readWorkflowProjectDownloadWithBackend(relativePath, version);
  res.setHeader('Content-Type', 'application/x-yaml; charset=utf-8');
  res.setHeader('Content-Disposition', createWorkflowDownloadContentDisposition(download.fileName));
  res.status(200).send(download.contents);
}));

workflowsRouter.post('/projects/publish', validateBody(publishProjectSchema), asyncHandler(async (req, res) => {
  const { relativePath, settings } = req.body as z.infer<typeof publishProjectSchema>;
  res.json({ project: await publishWorkflowProjectItemWithBackend(relativePath, settings) });
}));

workflowsRouter.post('/projects/unpublish', validateBody(pathOnlySchema), asyncHandler(async (req, res) => {
  const { relativePath } = req.body as z.infer<typeof pathOnlySchema>;
  res.json({ project: await unpublishWorkflowProjectItemWithBackend(relativePath) });
}));

workflowsRouter.delete('/projects', validateBody(pathOnlySchema), asyncHandler(async (req, res) => {
  const { relativePath } = req.body as z.infer<typeof pathOnlySchema>;
  const projectId = await deleteWorkflowProjectItemWithBackend(relativePath);
  res.json({ deleted: true, projectId });
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
