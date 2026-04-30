import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect } from 'react';
import { useExecutorSessionHostConfig, useExecutorSessionRuntime } from '../../../../rivet/packages/app/src/providers/ExecutorSessionContext.js';
import {
  remoteDebuggerConfigState,
  remoteDebuggerConnectionState,
} from '../../../../rivet/packages/app/src/state/execution.js';
import { defaultExecutorState } from '../state/settings';
import { isInTauri } from '../../../../rivet/packages/app/src/utils/platform/core.js';
import {
  attachAndStartExecutorSidecar,
  detachAndStopExecutorSidecar,
  executorSidecarRuntime,
} from '../../../../rivet/packages/app/src/hooks/useExecutorSidecar';
import { markHostedInternalExecutorSession } from './hostedInternalExecutorSession';
import { useRemoteDebugger } from './useHostedRemoteDebugger';

export function useExecutorSession(selectedExecutor: 'browser' | 'nodejs') {
  const runtime = useExecutorSessionRuntime();
  const hostConfig = useExecutorSessionHostConfig();
  const remoteDebugger = useRemoteDebugger();
  const setDefaultExecutor = useSetAtom(defaultExecutorState);

  useEffect(() => {
    if (selectedExecutor !== 'nodejs') {
      runtime.disconnect();
      return () => {
        runtime.disconnect();
      };
    }

    if (hostConfig?.internalExecutorUrl) {
      void runtime.connect(hostConfig.internalExecutorUrl);

      return () => {
        runtime.disconnect();
      };
    }

    if (!isInTauri()) {
      setDefaultExecutor('browser');
      runtime.disconnect();
      return;
    }

    let cancelled = false;

    void (async () => {
      await attachAndStartExecutorSidecar();

      if (!cancelled && executorSidecarRuntime.started) {
        await runtime.connectInternal();
      }
    })();

    return () => {
      cancelled = true;
      runtime.disconnect();
      void detachAndStopExecutorSidecar();
    };
  }, [hostConfig?.internalExecutorUrl, runtime, selectedExecutor, setDefaultExecutor]);

  return remoteDebugger;
}

export function useExecutorSessionState() {
  const runtime = useExecutorSessionRuntime();
  const debuggerConfig = useAtomValue(remoteDebuggerConfigState);
  const connectionState = useAtomValue(remoteDebuggerConnectionState);
  return markHostedInternalExecutorSession(runtime.buildSessionState(debuggerConfig, connectionState));
}