import { Router, type Request, type Response } from 'express';
import { loadProjectFromFile, NodeDatasetProvider, runGraph } from '@ironclad/rivet-node';

import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, createHttpError } from '../../utils/httpError.js';
import { ensureWorkflowsRoot } from './fs-helpers.js';
import {
  createPublishedWorkflowProjectReferenceLoader,
  findLatestWorkflowByEndpoint,
  findPublishedWorkflowByEndpoint,
  normalizeStoredEndpointName,
} from './publication.js';
import { ManagedCodeRunner } from '../../runtime-libraries/managed-code-runner.js';
import { getRootPath } from '../../runtime-libraries/manifest.js';

export const publishedWorkflowsRouter = Router();
export const latestWorkflowsRouter = Router();

function getBearerToken(req: Request): string | null {
  const authorization = req.get('authorization');
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() || null : null;
}

function requirePublishedWorkflowApiKey(req: Request): void {
  const expectedApiKey = process.env.RIVET_ENDPOINT_API_KEY?.trim();
  if (!expectedApiKey) {
    return;
  }

  const providedApiKey = getBearerToken(req);
  if (!providedApiKey || providedApiKey !== expectedApiKey) {
    throw createHttpError(401, 'Unauthorized');
  }
}

async function executeWorkflowEndpoint(
  loadPath: string,
  referencePath: string,
  root: string,
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const project = await loadProjectFromFile(loadPath);
    const datasetProvider = await NodeDatasetProvider.fromProjectFile(loadPath);
    const projectReferenceLoader = createPublishedWorkflowProjectReferenceLoader(root, referencePath);
    const outputs = await runGraph(project, {
      codeRunner: new ManagedCodeRunner(getRootPath()) as any,
      projectPath: referencePath,
      datasetProvider,
      projectReferenceLoader,
      inputs: {
        input: {
          type: 'any',
          value: {
            payload: req.body ?? {},
          },
        },
      },
    });

    const outputValue = outputs.output;
    if (outputValue?.type === 'any' && outputValue.value != null && typeof outputValue.value === 'object') {
      res.status(200).json(outputValue.value);
      return;
    }

    res.status(200).json(outputs);
  } catch (error) {
    const errorPayload = error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : {
          message: String(error),
        };

    res.status(500).json({ error: errorPayload });
  }
}

publishedWorkflowsRouter.post('/:endpointName', asyncHandler(async (req, res) => {
  requirePublishedWorkflowApiKey(req);

  const root = await ensureWorkflowsRoot();
  const endpointName = normalizeStoredEndpointName(String(req.params.endpointName ?? ''));
  if (!endpointName) {
    throw badRequest('Endpoint name is required');
  }

  const publishedWorkflow = await findPublishedWorkflowByEndpoint(root, endpointName);
  if (!publishedWorkflow) {
    res.status(404).json({ error: 'Published workflow not found' });
    return;
  }

  await executeWorkflowEndpoint(
    publishedWorkflow.publishedProjectPath,
    publishedWorkflow.projectPath,
    root,
    req,
    res,
  );
}));

latestWorkflowsRouter.post('/:endpointName', asyncHandler(async (req, res) => {
  const root = await ensureWorkflowsRoot();
  const endpointName = normalizeStoredEndpointName(String(req.params.endpointName ?? ''));
  if (!endpointName) {
    throw badRequest('Endpoint name is required');
  }

  const latestWorkflow = await findLatestWorkflowByEndpoint(root, endpointName);
  if (!latestWorkflow) {
    res.status(404).json({ error: 'Latest workflow not found' });
    return;
  }

  await executeWorkflowEndpoint(
    latestWorkflow.projectPath,
    latestWorkflow.projectPath,
    root,
    req,
    res,
  );
}));
