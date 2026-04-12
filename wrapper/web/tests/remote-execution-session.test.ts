import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginRemoteExecutionSession,
  rejectRemoteExecutionSession,
  REMOTE_EXECUTION_SESSION_SUPERSEDED_MESSAGE,
  resolveRemoteExecutionSession,
} from '../overrides/hooks/remoteExecutionSession.js';

test('remote execution sessions resolve the active promise', async () => {
  const results = { output: 'ok' } as any;
  const pending = beginRemoteExecutionSession();

  resolveRemoteExecutionSession(results);

  assert.deepEqual(await pending, results);
});

test('remote execution sessions reject the active promise', async () => {
  const pending = beginRemoteExecutionSession();

  rejectRemoteExecutionSession(new Error('boom'));

  await assert.rejects(pending, /boom/);
});

test('starting a new remote execution session supersedes the previous unresolved run', async () => {
  const firstPending = beginRemoteExecutionSession();
  const firstRejected = assert.rejects(firstPending, new RegExp(REMOTE_EXECUTION_SESSION_SUPERSEDED_MESSAGE));

  const secondPending = beginRemoteExecutionSession();
  await firstRejected;

  const results = { next: true } as any;
  resolveRemoteExecutionSession(results);
  assert.deepEqual(await secondPending, results);

  rejectRemoteExecutionSession(new Error('ignored'));
  resolveRemoteExecutionSession({} as any);
});
