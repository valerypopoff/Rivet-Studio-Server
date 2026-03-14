import { Router, type Request, type Response } from 'express';
import { loadProjectFromFile, NodeDatasetProvider, runGraph } from '@ironclad/rivet-node';

import { getLatestWorkflowRemoteDebugger, isLatestWorkflowRemoteDebuggerEnabled } from '../../latestWorkflowRemoteDebugger.js';
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
export const internalPublishedWorkflowsRouter = Router();
export const latestWorkflowsRouter = Router();

function getBearerToken(req: Request): string | null {
  const authorization = req.get('authorization');
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() || null : null;
}

function isEnvFlagEnabled(value: string | undefined, defaultValue = false): boolean {
  if (value == null) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return defaultValue;
}

function normalizeHostName(value: string | null | undefined): string {
  const rawHost = (value ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  if (!rawHost) {
    return '';
  }

  if (rawHost.startsWith('[')) {
    const closingBracketIndex = rawHost.indexOf(']');
    return closingBracketIndex === -1 ? rawHost : rawHost.slice(0, closingBracketIndex + 1);
  }

  const colonIndex = rawHost.indexOf(':');
  return colonIndex === -1 ? rawHost : rawHost.slice(0, colonIndex);
}

function getRequestHostName(req: Request): string {
  return normalizeHostName(req.get('x-forwarded-host') || req.get('host'));
}

function getTokenFreeHosts(): Set<string> {
  return new Set(
    (process.env.RIVET_UI_TOKEN_FREE_HOSTS ?? '')
      .split(',')
      .map((host) => normalizeHostName(host))
      .filter(Boolean),
  );
}

function shouldBypassWorkflowApiKeyForHost(req: Request): boolean {
  const requestHost = getRequestHostName(req);
  if (!requestHost) {
    return false;
  }

  return getTokenFreeHosts().has(requestHost);
}

function requirePublishedWorkflowApiKey(req: Request): void {
  const isWorkflowKeyRequired = isEnvFlagEnabled(process.env.RIVET_REQUIRE_WORKFLOW_KEY, false);
  if (!isWorkflowKeyRequired) {
    return;
  }

  if (shouldBypassWorkflowApiKeyForHost(req)) {
    return;
  }

  const expectedApiKey = process.env.RIVET_KEY?.trim();
  if (!expectedApiKey) {
    throw createHttpError(500, 'Workflow execution key is required but RIVET_KEY is not configured');
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
  options?: { enableRemoteDebugger?: boolean },
): Promise<void> {
  try {
    const project = await loadProjectFromFile(loadPath);
    const datasetProvider = await NodeDatasetProvider.fromProjectFile(loadPath);
    const projectReferenceLoader = createPublishedWorkflowProjectReferenceLoader(root, referencePath);
    const remoteDebugger = options?.enableRemoteDebugger && isLatestWorkflowRemoteDebuggerEnabled()
      ? getLatestWorkflowRemoteDebugger()
      : undefined;
    const outputs = await runGraph(project, {
      codeRunner: new ManagedCodeRunner(getRootPath()) as any,
      projectPath: referencePath,
      datasetProvider,
      projectReferenceLoader,
      remoteDebugger,
      inputs: {
        input: {
          type: 'any',
          value: req.body || {}          
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
    console.error('Workflow execution failed:', error);
    const errorPayload = error instanceof Error
      ? {
          name: error.name,
          message: error.message,
        }
      : {
          message: String(error),
        };

    res.status(500).json({ error: errorPayload });
  }
}

async function handlePublishedWorkflowRequest(
  req: Request,
  res: Response,
  options?: { requireApiKey?: boolean },
): Promise<void> {
  if (options?.requireApiKey !== false) {
    requirePublishedWorkflowApiKey(req);
  }

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
    { enableRemoteDebugger: false },
  );
}

publishedWorkflowsRouter.post('/:endpointName', asyncHandler(async (req, res) => {
  await handlePublishedWorkflowRequest(req, res);
}));

internalPublishedWorkflowsRouter.post('/:endpointName', asyncHandler(async (req, res) => {
  await handlePublishedWorkflowRequest(req, res, { requireApiKey: false });
}));

latestWorkflowsRouter.post('/:endpointName', asyncHandler(async (req, res) => {
  requirePublishedWorkflowApiKey(req);

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
    { enableRemoteDebugger: true },
  );
}));
