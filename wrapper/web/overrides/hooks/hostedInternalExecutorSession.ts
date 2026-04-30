import type { ExecutorSessionState } from '../../../../rivet/packages/app/src/hooks/executorSession';

const HOSTED_INTERNAL_EXECUTOR_PATH = '/ws/executor/internal';

export function isHostedInternalExecutorUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    return new URL(url, 'ws://localhost').pathname === HOSTED_INTERNAL_EXECUTOR_PATH;
  } catch {
    return false;
  }
}

export function markHostedInternalExecutorSession<T extends ExecutorSessionState>(session: T): T {
  if (!isHostedInternalExecutorUrl(session.url) || session.isInternalExecutor) {
    return session;
  }

  return { ...session, isInternalExecutor: true };
}