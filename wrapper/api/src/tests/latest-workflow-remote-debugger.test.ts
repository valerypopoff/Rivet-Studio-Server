import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

const envKeys = [
  'RIVET_WORKSPACE_ROOT',
  'RIVET_WORKFLOWS_ROOT',
  'RIVET_APP_DATA_ROOT',
  'RIVET_RUNTIME_LIBRARIES_ROOT',
  'RIVET_STORAGE_MODE',
  'RIVET_KEY',
  'RIVET_REQUIRE_WORKFLOW_KEY',
  'RIVET_ENABLE_LATEST_REMOTE_DEBUGGER',
  'RIVET_RECORDINGS_ENABLED',
] as const;

const previousEnv = new Map<string, string | undefined>();
for (const key of envKeys) {
  previousEnv.set(key, process.env[key]);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-latest-debugger-'));
const workflowsRoot = path.join(tempRoot, 'workflows');
const appDataRoot = path.join(tempRoot, 'app-data');
const runtimeLibrariesRoot = path.join(tempRoot, 'runtime-libraries');

process.env.RIVET_WORKSPACE_ROOT = tempRoot;
process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
process.env.RIVET_APP_DATA_ROOT = appDataRoot;
process.env.RIVET_RUNTIME_LIBRARIES_ROOT = runtimeLibrariesRoot;
process.env.RIVET_STORAGE_MODE = 'filesystem';
process.env.RIVET_KEY = 'latest-debugger-test-key';
process.env.RIVET_REQUIRE_WORKFLOW_KEY = 'false';
process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER = 'false';
process.env.RIVET_RECORDINGS_ENABLED = 'false';

const { getExpectedProxyAuthToken } = await import('../auth.js');
const { createApiApp } = await import('../app.js');
const {
  initializeLatestWorkflowRemoteDebugger,
  resetLatestWorkflowRemoteDebuggerForTests,
} = await import('../latestWorkflowRemoteDebugger.js');
const workflowFs = await import('../routes/workflows/fs-helpers.js');
const workflowMutations = await import('../routes/workflows/workflow-mutations.js');

type ApiProfile = 'combined' | 'control' | 'execution';

type DebuggerMessage = {
  message: string;
  data: unknown;
};

type DebuggerConnectionFailure = {
  statusCode?: number;
  error?: Error;
};

function trustedProxyHeaders(): Record<string, string> {
  return {
    'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
  };
}

function toWebSocketUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/, 'ws') + '/ws/latest-debugger';
}

function parseDebuggerMessage(raw: WebSocket.RawData): DebuggerMessage {
  const parsed = JSON.parse(raw.toString()) as {
    message?: string;
    type?: string;
    data?: unknown;
  };
  const message = parsed.message ?? parsed.type;
  if (!message) {
    throw new Error(`Debugger message missing message/type field: ${raw.toString()}`);
  }

  return {
    message,
    data: parsed.data,
  };
}

async function resetFilesystemState(): Promise<void> {
  await resetLatestWorkflowRemoteDebuggerForTests();
  process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER = 'false';

  for (const dirPath of [workflowsRoot, appDataRoot, runtimeLibrariesRoot]) {
    await fs.rm(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.mkdir(dirPath, { recursive: true });
  }

  await workflowFs.ensureWorkflowsRoot();
}

async function createPublishedWorkflow(projectName: string, endpointName: string) {
  const created = await workflowMutations.createWorkflowProjectItem('', projectName);
  await workflowMutations.publishWorkflowProjectItem(created.relativePath, { endpointName });
  return created;
}

async function startApiServer(
  profile: ApiProfile,
  options: { debuggerEnabled?: boolean } = {},
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER = options.debuggerEnabled ? 'true' : 'false';

  const app = createApiApp(profile);
  const server = http.createServer(app);

  if (profile === 'combined' || profile === 'control') {
    initializeLatestWorkflowRemoteDebugger(server);
  }

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind latest debugger test server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await resetLatestWorkflowRemoteDebuggerForTests();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
        server.closeAllConnections?.();
      });
    },
  };
}

async function connectDebuggerSocket(baseUrl: string, trusted = true): Promise<WebSocket> {
  const socket = new WebSocket(toWebSocketUrl(baseUrl), {
    headers: trusted ? trustedProxyHeaders() : {},
  });

  const connection = await new Promise<{ socket?: WebSocket; failure?: DebuggerConnectionFailure }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      closeDebuggerSocket(socket);
      reject(new Error('Timed out connecting to /ws/latest-debugger'));
    }, 3000);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('open', handleOpen);
      socket.off('unexpected-response', handleUnexpectedResponse);
      socket.off('error', handleError);
    };

    const handleOpen = () => {
      cleanup();
      resolve({ socket });
    };

    const handleUnexpectedResponse = (_request: http.ClientRequest, response: http.IncomingMessage) => {
      cleanup();
      response.resume();
      resolve({ failure: { statusCode: response.statusCode } });
    };

    const handleError = (error: Error) => {
      cleanup();
      resolve({ failure: { error } });
    };

    socket.once('open', handleOpen);
    socket.once('unexpected-response', handleUnexpectedResponse);
    socket.once('error', handleError);
  });

  if (!connection.socket) {
    throw new Error(`Expected debugger websocket to connect, got ${JSON.stringify(connection.failure)}`);
  }

  return connection.socket;
}

async function expectDebuggerConnectionFailure(
  baseUrl: string,
  trusted = true,
): Promise<DebuggerConnectionFailure> {
  const socket = new WebSocket(toWebSocketUrl(baseUrl), {
    headers: trusted ? trustedProxyHeaders() : {},
  });

  const failure = await new Promise<DebuggerConnectionFailure | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      closeDebuggerSocket(socket);
      reject(new Error('Timed out waiting for debugger websocket failure'));
    }, 3000);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('open', handleOpen);
      socket.off('unexpected-response', handleUnexpectedResponse);
      socket.off('error', handleError);
    };

    const handleOpen = () => {
      cleanup();
      resolve(null);
    };

    const handleUnexpectedResponse = (_request: http.ClientRequest, response: http.IncomingMessage) => {
      cleanup();
      response.resume();
      resolve({ statusCode: response.statusCode });
    };

    const handleError = (error: Error) => {
      cleanup();
      resolve({ error });
    };

    socket.once('open', handleOpen);
    socket.once('unexpected-response', handleUnexpectedResponse);
    socket.once('error', handleError);
  });

  if (failure == null) {
    closeDebuggerSocket(socket);
    throw new Error('Expected debugger websocket connection to fail, but it opened successfully');
  }

  closeDebuggerSocket(socket);
  return failure;
}

async function waitForDebuggerMessages(
  socket: WebSocket,
  expectedMessages: string[],
  timeoutMs = 5000,
): Promise<DebuggerMessage[]> {
  const seen = new Set<string>();
  const messages: DebuggerMessage[] = [];

  return await new Promise<DebuggerMessage[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for debugger messages: ${expectedMessages.join(', ')}`));
    }, timeoutMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', handleMessage);
      socket.off('close', handleClose);
      socket.off('error', handleError);
    };

    const handleMessage = (raw: WebSocket.RawData) => {
      const message = parseDebuggerMessage(raw);
      messages.push(message);
      seen.add(message.message);
      if (expectedMessages.every((expected) => seen.has(expected))) {
        cleanup();
        resolve(messages);
      }
    };

    const handleClose = () => {
      cleanup();
      reject(new Error('Debugger websocket closed before all expected messages arrived'));
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.on('message', handleMessage);
    socket.once('close', handleClose);
    socket.once('error', handleError);
  });
}

async function assertNoDebuggerMessages(socket: WebSocket, timeoutMs = 500): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', handleMessage);
      socket.off('error', handleError);
    };

    const handleMessage = (raw: WebSocket.RawData) => {
      cleanup();
      reject(new Error(`Expected no debugger messages, got ${raw.toString()}`));
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.on('message', handleMessage);
    socket.once('error', handleError);
  });
}

function closeDebuggerSocket(socket: WebSocket | null | undefined): void {
  if (!socket) {
    return;
  }

  socket.removeAllListeners();
  if (socket.readyState === WebSocket.OPEN) {
    socket.terminate();
  }
}

async function assertSuccessfulBlankWorkflowResponse(response: Response): Promise<void> {
  assert.equal(response.status, 200);
  const payload = await response.json() as { durationMs: number };
  assert.equal(typeof payload.durationMs, 'number');
}

test.beforeEach(async () => {
  await resetFilesystemState();
});

test.afterEach(async () => {
  await resetLatestWorkflowRemoteDebuggerForTests();
});

test.after(async () => {
  await resetLatestWorkflowRemoteDebuggerForTests();
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

  for (const key of envKeys) {
    const previousValue = previousEnv.get(key);
    if (previousValue == null) {
      delete process.env[key];
    } else {
      process.env[key] = previousValue;
    }
  }
});

test('latest debugger receives events for latest endpoint execution', async () => {
  await createPublishedWorkflow('Latest Debugger Fixture', 'latest-debugger-endpoint');
  const server = await startApiServer('control', { debuggerEnabled: true });
  let socket: WebSocket | null = null;

  try {
    socket = await connectDebuggerSocket(server.baseUrl);
    const messagesPromise = waitForDebuggerMessages(socket, ['start', 'done']);

    const response = await fetch(`${server.baseUrl}/workflows-latest/latest-debugger-endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'latest' }),
      signal: AbortSignal.timeout(5000),
    });

    await assertSuccessfulBlankWorkflowResponse(response);

    const messages = await messagesPromise;
    assert.ok(messages.some((message) => message.message === 'start'));
    assert.ok(messages.some((message) => message.message === 'done'));
  } finally {
    closeDebuggerSocket(socket);
    await server.close();
  }
});

test('published endpoint execution does not emit latest debugger events', async () => {
  await createPublishedWorkflow('Published Debugger Fixture', 'published-no-debugger-endpoint');
  const server = await startApiServer('combined', { debuggerEnabled: true });
  let socket: WebSocket | null = null;

  try {
    socket = await connectDebuggerSocket(server.baseUrl);

    const response = await fetch(`${server.baseUrl}/workflows/published-no-debugger-endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'published' }),
      signal: AbortSignal.timeout(5000),
    });

    await assertSuccessfulBlankWorkflowResponse(response);

    await assertNoDebuggerMessages(socket);
  } finally {
    closeDebuggerSocket(socket);
    await server.close();
  }
});

test('latest debugger websocket rejects untrusted upgrades', async () => {
  const server = await startApiServer('control', { debuggerEnabled: true });

  try {
    const failure = await expectDebuggerConnectionFailure(server.baseUrl, false);
    assert.equal(failure.statusCode, 401);
  } finally {
    await server.close();
  }
});

test('latest debugger websocket is unavailable when disabled', async () => {
  const server = await startApiServer('control', { debuggerEnabled: false });

  try {
    const failure = await expectDebuggerConnectionFailure(server.baseUrl);
    assert.equal(failure.statusCode, 404);
  } finally {
    await server.close();
  }
});

test('execution-only profile does not provide latest debugger', async () => {
  const server = await startApiServer('execution', { debuggerEnabled: true });

  try {
    const failure = await expectDebuggerConnectionFailure(server.baseUrl);
    assert.ok(failure.statusCode != null || failure.error != null);
  } finally {
    await server.close();
  }
});

test('api config advertises latest debugger websocket only when supported', async () => {
  const controlEnabled = await startApiServer('control', { debuggerEnabled: true });
  try {
    const response = await fetch(`${controlEnabled.baseUrl}/api/config`, {
      headers: trustedProxyHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { remoteDebuggerDefaultWs: string };
    assert.match(payload.remoteDebuggerDefaultWs, /^ws:\/\/127\.0\.0\.1:\d+\/ws\/latest-debugger$/);
  } finally {
    await controlEnabled.close();
  }

  const combinedDisabled = await startApiServer('combined', { debuggerEnabled: false });
  try {
    const response = await fetch(`${combinedDisabled.baseUrl}/api/config`, {
      headers: trustedProxyHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { remoteDebuggerDefaultWs: string };
    assert.equal(payload.remoteDebuggerDefaultWs, '');
  } finally {
    await combinedDisabled.close();
  }

  const execution = await startApiServer('execution', { debuggerEnabled: true });
  try {
    const response = await fetch(`${execution.baseUrl}/api/config`, {
      headers: trustedProxyHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  } finally {
    await execution.close();
  }
});

test('multiple debugger clients on the single backend all observe latest runs', async () => {
  await createPublishedWorkflow('Multi Client Fixture', 'multi-client-latest-endpoint');
  const server = await startApiServer('control', { debuggerEnabled: true });
  let firstSocket: WebSocket | null = null;
  let secondSocket: WebSocket | null = null;

  try {
    firstSocket = await connectDebuggerSocket(server.baseUrl);
    secondSocket = await connectDebuggerSocket(server.baseUrl);

    const firstMessagesPromise = waitForDebuggerMessages(firstSocket, ['start', 'done']);
    const secondMessagesPromise = waitForDebuggerMessages(secondSocket, ['start', 'done']);

    const response = await fetch(`${server.baseUrl}/workflows-latest/multi-client-latest-endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'latest' }),
      signal: AbortSignal.timeout(5000),
    });

    await assertSuccessfulBlankWorkflowResponse(response);

    const [firstMessages, secondMessages] = await Promise.all([
      firstMessagesPromise,
      secondMessagesPromise,
    ]);

    assert.ok(firstMessages.some((message) => message.message === 'start'));
    assert.ok(firstMessages.some((message) => message.message === 'done'));
    assert.ok(secondMessages.some((message) => message.message === 'start'));
    assert.ok(secondMessages.some((message) => message.message === 'done'));
  } finally {
    closeDebuggerSocket(firstSocket);
    closeDebuggerSocket(secondSocket);
    await server.close();
  }
});
