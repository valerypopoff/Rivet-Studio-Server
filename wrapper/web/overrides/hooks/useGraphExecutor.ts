// Override for rivet/packages/app/src/hooks/useGraphExecutor.ts
// Uses env-driven WebSocket URL instead of hardcoded ws://localhost:21889/internal

import { useEffect, useCallback, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { selectedExecutorState } from '../../../../rivet/packages/app/src/state/execution';
import { graphState } from '../../../../rivet/packages/app/src/state/graph';
import { projectState } from '../../../../rivet/packages/app/src/state/savedGraphs';
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
  const graph = useAtomValue(graphState);
  const project = useAtomValue(projectState);

  useExecutorSidecar({ enabled: selectedExecutor === 'nodejs' });

  // In hosted mode, executor is determined by the user's selection — not by WS connection state.
  const executor = selectedExecutor === 'nodejs' ? remoteExecutor : localExecutor;

  // Keep a ref to the latest executor so the stable wrapper always calls the current one
  const executorRef = useRef(executor);
  executorRef.current = executor;

  // !! DEBUG — log on every render so we can see state
  console.error(
    '[HOSTED-DEBUG] useGraphExecutor render: executor=%s, graph.id=%s, graph.nodes=%d, project.graphs keys=[%s]',
    selectedExecutor,
    graph.metadata?.id,
    graph.nodes.length,
    Object.keys(project.graphs ?? {}).join(', '),
  );

  // Stable wrapper that adds diagnostic logging visible in the console
  const tryRunGraph = useCallback(
    async (options: { graphId?: string; to?: string[]; from?: string } = {}) => {
      console.error(
        '[HOSTED-DEBUG] tryRunGraph CALLED: executor=%s, graphId=%s',
        selectedExecutor,
        options.graphId,
      );
      try {
        await executorRef.current.tryRunGraph(options);
        console.error('[HOSTED-DEBUG] tryRunGraph COMPLETED');
      } catch (e: any) {
        console.error('[HOSTED-DEBUG] tryRunGraph ERROR:', e);
      }
    },
    [selectedExecutor],
  );

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
    tryRunGraph,
    tryAbortGraph: executor.tryAbortGraph,
    tryPauseGraph: executor.tryPauseGraph,
    tryResumeGraph: executor.tryResumeGraph,
    tryRunTests: executor.tryRunTests,
  };
}
