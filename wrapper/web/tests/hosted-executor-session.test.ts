import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutorSessionState } from '../../rivet/packages/app/src/hooks/executorSession';
import {
  isHostedInternalExecutorUrl,
  markHostedInternalExecutorSession,
} from '../overrides/hooks/hostedInternalExecutorSession';

const baseSession: ExecutorSessionState = {
  isInternalExecutor: false,
  reconnecting: false,
  remoteUploadAllowed: false,
  socket: null,
  started: true,
  status: 'ready',
  url: 'ws://127.0.0.1:8081/ws/executor/internal',
};

describe('hosted internal executor session classification', () => {
  test('treats the hosted proxied executor websocket as internal executor mode', () => {
    assert.equal(isHostedInternalExecutorUrl('ws://127.0.0.1:8081/ws/executor/internal'), true);
    assert.equal(isHostedInternalExecutorUrl('wss://example.test/ws/executor/internal'), true);
    assert.equal(isHostedInternalExecutorUrl('ws://127.0.0.1:8081/ws/latest-debugger'), false);
  });

  test('marks hosted executor sessions as internal without mutating unrelated remote debugger sessions', () => {
    assert.deepEqual(markHostedInternalExecutorSession(baseSession), {
      ...baseSession,
      isInternalExecutor: true,
    });

    const remoteSession = {
      ...baseSession,
      url: 'ws://127.0.0.1:8081/ws/latest-debugger',
    };

    assert.equal(markHostedInternalExecutorSession(remoteSession), remoteSession);
  });
});