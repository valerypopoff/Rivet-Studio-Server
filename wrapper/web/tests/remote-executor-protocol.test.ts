import assert from 'node:assert/strict';
import test from 'node:test';

import { beginRemoteExecutionSession, rejectRemoteExecutionSession } from '../overrides/hooks/remoteExecutionSession.js';
import { createRemoteExecutorMessageHandler } from '../overrides/hooks/remoteExecutorProtocol.js';

function createAdapter() {
  const calls = {
    abort: [] as unknown[],
    done: [] as unknown[],
    error: [] as unknown[],
    pause: 0,
    resume: 0,
    trace: [] as unknown[],
  };

  return {
    calls,
    adapter: {
      onAbort(data: unknown) {
        calls.abort.push(data);
      },
      onDone(data: unknown) {
        calls.done.push(data);
      },
      onError(data: unknown) {
        calls.error.push(data);
      },
      onGraphAbort() {},
      onGraphFinish() {},
      onGraphStart() {},
      onNodeError() {},
      onNodeExcluded() {},
      onNodeFinish() {},
      onNodeOutputsCleared() {},
      onNodeStart() {},
      onPartialOutput() {},
      onPause() {
        calls.pause += 1;
      },
      onResume() {
        calls.resume += 1;
      },
      onStart() {},
      onUserInput() {},
    },
  };
}

test('remote executor protocol resolves the active remote session on done', async () => {
  const { adapter, calls } = createAdapter();
  const handler = createRemoteExecutorMessageHandler(adapter as any);
  const pending = beginRemoteExecutionSession();
  const results = { finished: true } as any;

  handler('done', { results });

  assert.deepEqual(await pending, results);
  assert.deepEqual(calls.done, [{ results }]);
});

test('remote executor protocol rejects the active remote session on abort and error', async () => {
  {
    const { adapter, calls } = createAdapter();
    const handler = createRemoteExecutorMessageHandler(adapter as any);
    const pending = beginRemoteExecutionSession();

    handler('abort', { reason: 'stopped' });

    await assert.rejects(pending, /graph execution aborted/);
    assert.deepEqual(calls.abort, [{ reason: 'stopped' }]);
  }

  {
    const { adapter, calls } = createAdapter();
    const handler = createRemoteExecutorMessageHandler(adapter as any);
    const pending = beginRemoteExecutionSession();
    const error = new Error('remote failure');

    handler('error', { error });

    await assert.rejects(pending, /remote failure/);
    assert.deepEqual(calls.error, [{ error }]);
  }
});

test('remote executor protocol forwards pause, resume, trace, and warns on unhandled messages', async () => {
  const { adapter, calls } = createAdapter();
  const handler = createRemoteExecutorMessageHandler(adapter as any);
  const originalWarn = console.warn;
  const originalLog = console.log;
  const warnings: unknown[][] = [];
  const logs: unknown[][] = [];

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };

  try {
    handler('pause', undefined);
    handler('resume', undefined);
    handler('trace', { level: 'log', message: 'hello' });
    handler('unexpected', { payload: true });
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
    rejectRemoteExecutionSession(new Error('cleanup'));
  }

  assert.equal(calls.pause, 1);
  assert.equal(calls.resume, 1);
  assert.deepEqual(logs, [['sidecar stdout', 'hello']]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0], ['Unhandled remote debugger message', 'unexpected', { payload: true }]);
});
