import type { GraphOutputs } from '@ironclad/rivet-core';

type RemoteExecutionSession = {
  promise: Promise<GraphOutputs>;
  resolve: (value: GraphOutputs) => void;
  reject: (reason?: unknown) => void;
};

export const REMOTE_EXECUTION_SESSION_SUPERSEDED_MESSAGE = 'Remote execution session was superseded by a new run.';

let activeSession: RemoteExecutionSession | null = null;

export function beginRemoteExecutionSession(): Promise<GraphOutputs> {
  if (activeSession) {
    activeSession.reject(new Error(REMOTE_EXECUTION_SESSION_SUPERSEDED_MESSAGE));
    activeSession = null;
  }

  let resolve!: (value: GraphOutputs) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<GraphOutputs>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  // The hosted remote debugger protocol is still single-run. A new run
  // supersedes the previous unresolved session instead of pretending to
  // support concurrency.
  activeSession = {
    promise,
    resolve,
    reject,
  };

  return promise;
}

export function resolveRemoteExecutionSession(results: GraphOutputs): void {
  activeSession?.resolve(results);
  activeSession = null;
}

export function rejectRemoteExecutionSession(reason?: unknown): void {
  activeSession?.reject(reason);
  activeSession = null;
}
