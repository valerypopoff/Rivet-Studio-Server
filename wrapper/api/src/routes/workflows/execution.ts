import { performance } from 'node:perf_hooks';
import { Router, type Request, type Response } from 'express';
import {
  createProcessor,
  ExecutionRecorder,
  loadProjectAndAttachedDataFromFile,
  NodeDatasetProvider,
} from '@ironclad/rivet-node';

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
import { isTrustedTokenFreeHostRequest } from '../../auth.js';
import { persistWorkflowExecutionRecording } from './recordings.js';

export const publishedWorkflowsRouter = Router();
export const internalPublishedWorkflowsRouter = Router();
export const latestWorkflowsRouter = Router();

function isJsonObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sendJsonWithDuration(
  res: Response,
  statusCode: number,
  payload: unknown,
  requestStartedAt: number,
): void {
  const durationMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
  res.set('x-duration-ms', String(durationMs));

  if (isJsonObjectRecord(payload) && !Object.prototype.hasOwnProperty.call(payload, 'durationMs')) {
    res.status(statusCode).json({
      ...payload,
      durationMs,
    });
    return;
  }

  res.status(statusCode).json(payload);
}

function sendWorkflowErrorWithDuration(
  res: Response,
  error: unknown,
  requestStartedAt: number,
): void {
  const status = typeof error === 'object' && error != null && 'status' in error && typeof error.status === 'number'
    ? error.status
    : 500;

  console.error('Workflow execution failed:', error);

  const errorPayload = error instanceof Error
    ? {
        name: error.name,
        message: error.message,
      }
    : {
        message: String(error),
      };

  sendJsonWithDuration(res, status, {
    error: errorPayload,
  }, requestStartedAt);
}

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

function getWorkflowErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function requirePublishedWorkflowApiKey(req: Request): void {
  const isWorkflowKeyRequired = isEnvFlagEnabled(process.env.RIVET_REQUIRE_WORKFLOW_KEY, false);
  if (!isWorkflowKeyRequired) {
    return;
  }

  if (isTrustedTokenFreeHostRequest(req)) {
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
  requestStartedAt: number,
  req: Request,
  res: Response,
  options: {
    enableRemoteDebugger?: boolean;
    endpointName: string;
    runKind: 'published' | 'latest';
  },
): Promise<void> {
  const [project, attachedData] = await loadProjectAndAttachedDataFromFile(loadPath);
  const datasetProvider = await NodeDatasetProvider.fromProjectFile(loadPath);
  const projectReferenceLoader = createPublishedWorkflowProjectReferenceLoader(root, referencePath);
  const remoteDebugger = options?.enableRemoteDebugger && isLatestWorkflowRemoteDebuggerEnabled()
    ? getLatestWorkflowRemoteDebugger()
    : undefined;
  const processor = createProcessor(project, {
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
  const recorder = new ExecutionRecorder({
    includePartialOutputs: true,
    includeTrace: true,
  });
  recorder.record(processor.processor);

  let recordingStatus: 'succeeded' | 'failed' = 'succeeded';
  let recordingErrorMessage: string | undefined;

  try {
    const outputs = await processor.run();

    const outputValue = outputs.output;
    if (outputValue?.type === 'any' && outputValue.value != null) {
      sendJsonWithDuration(res, 200, outputValue.value, requestStartedAt);
      return;
    }

    sendJsonWithDuration(res, 200, outputs, requestStartedAt);
  } catch (error) {
    recordingStatus = 'failed';
    recordingErrorMessage = getWorkflowErrorMessage(error);
    throw error;
  } finally {
    try {
      await persistWorkflowExecutionRecording({
        root,
        sourceProject: project,
        sourceProjectPath: referencePath,
        executedProject: project,
        executedAttachedData: attachedData,
        executedDatasets: await datasetProvider.exportDatasetsForProject(project.metadata.id),
        endpointName: options.endpointName,
        recordingSerialized: recorder.serialize(),
        runKind: options.runKind,
        status: recordingStatus,
        durationMs: performance.now() - requestStartedAt,
        errorMessage: recordingErrorMessage,
      });
    } catch (recordingError) {
      console.error('Failed to persist workflow execution recording:', recordingError);
    }
  }
}

async function handlePublishedWorkflowRequest(
  req: Request,
  res: Response,
  options?: { requireApiKey?: boolean },
): Promise<void> {
  const requestStartedAt = performance.now();

  try {
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
      sendJsonWithDuration(res, 404, { error: 'Published workflow not found' }, requestStartedAt);
      return;
    }

    await executeWorkflowEndpoint(
      publishedWorkflow.publishedProjectPath,
      publishedWorkflow.projectPath,
      root,
      requestStartedAt,
      req,
      res,
      {
        enableRemoteDebugger: false,
        endpointName,
        runKind: 'published',
      },
    );
  } catch (error) {
    sendWorkflowErrorWithDuration(res, error, requestStartedAt);
  }
}

publishedWorkflowsRouter.post('/:endpointName', asyncHandler(async (req, res) => {
  await handlePublishedWorkflowRequest(req, res);
}));

internalPublishedWorkflowsRouter.post('/:endpointName', asyncHandler(async (req, res) => {
  await handlePublishedWorkflowRequest(req, res, { requireApiKey: false });
}));

latestWorkflowsRouter.post('/:endpointName', asyncHandler(async (req, res) => {
  const requestStartedAt = performance.now();

  try {
    requirePublishedWorkflowApiKey(req);

    const root = await ensureWorkflowsRoot();
    const endpointName = normalizeStoredEndpointName(String(req.params.endpointName ?? ''));
    if (!endpointName) {
      throw badRequest('Endpoint name is required');
    }

    const latestWorkflow = await findLatestWorkflowByEndpoint(root, endpointName);
    if (!latestWorkflow) {
      sendJsonWithDuration(res, 404, { error: 'Latest workflow not found' }, requestStartedAt);
      return;
    }

    await executeWorkflowEndpoint(
      latestWorkflow.projectPath,
      latestWorkflow.projectPath,
      root,
      requestStartedAt,
      req,
      res,
      {
        enableRemoteDebugger: true,
        endpointName,
        runKind: 'latest',
      },
    );
  } catch (error) {
    sendWorkflowErrorWithDuration(res, error, requestStartedAt);
  }
}));
