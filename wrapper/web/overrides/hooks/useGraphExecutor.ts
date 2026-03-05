// Override for rivet/packages/app/src/hooks/useGraphExecutor.ts
// Uses env-driven WebSocket URL instead of hardcoded ws://localhost:21889/internal

import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { selectedExecutorState } from '../../../../rivet/packages/app/src/state/execution';
import { useExecutorSidecar } from './useExecutorSidecar';
import { useLocalExecutor } from '../../../../rivet/packages/app/src/hooks/useLocalExecutor';
import { useRemoteExecutor } from './useRemoteExecutor';
import { RIVET_EXECUTOR_WS_URL } from '../../../shared/hosted-env';

/**
 * Caution: only use this hook on components that will not dismount. The `useEffect` cleanup function
 * can result in a subtle bug where the remote debugger will mysteriously disconnect when the
 * component dismounts.
 * TODO Refactor so that this doesn't happen.
 * @returns
 */
export function useGraphExecutor() {
  const selectedExecutor = useAtomValue(selectedExecutorState);
  const localExecutor = useLocalExecutor();
  const remoteExecutor = useRemoteExecutor();

  useExecutorSidecar({ enabled: selectedExecutor === 'nodejs' });

  // In hosted mode, executor is determined by the user's selection — not by WS connection state.
  // The upstream logic (remoteExecutor.active || ...) causes browser mode to route to the remote
  // executor once any WS connection is established, which is wrong for hosted deployments.
  const executor = selectedExecutor === 'nodejs' ? remoteExecutor : localExecutor;

  useEffect(() => {
    if (selectedExecutor === 'nodejs') {
      remoteExecutor.remoteDebugger.connect(RIVET_EXECUTOR_WS_URL);
    } else {
      remoteExecutor.remoteDebugger.disconnect();
    }

    return () => {
      remoteExecutor.remoteDebugger.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExecutor]);

  return {
    tryRunGraph: executor.tryRunGraph,
    tryAbortGraph: executor.tryAbortGraph,
    tryPauseGraph: executor.tryPauseGraph,
    tryResumeGraph: executor.tryResumeGraph,
    tryRunTests: executor.tryRunTests,
  };
}
