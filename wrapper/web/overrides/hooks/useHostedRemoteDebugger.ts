import { useLatest } from 'ahooks';
import { useAtomValue } from 'jotai';
import { useEffect } from 'react';
import type { OutgoingMessageMap } from '@ironclad/rivet-core';
import { useExecutorSessionRuntime } from '../../../../rivet/packages/app/src/providers/ExecutorSessionContext.js';
import {
  remoteDebuggerConfigState,
  remoteDebuggerConnectionState,
} from '../../../../rivet/packages/app/src/state/execution.js';
import type { ExecutorSessionState } from '../../../../rivet/packages/app/src/hooks/executorSession';
import { markHostedInternalExecutorSession } from './hostedInternalExecutorSession';

export function useRemoteDebugger(options: { onConnect?: () => void; onDisconnect?: () => void } = {}) {
  const runtime = useExecutorSessionRuntime();
  const debuggerConfig = useAtomValue(remoteDebuggerConfigState);
  const connectionState = useAtomValue(remoteDebuggerConnectionState);
  const onConnectLatest = useLatest(options.onConnect ?? (() => {}));
  const onDisconnectLatest = useLatest(options.onDisconnect ?? (() => {}));

  useEffect(() => {
    const unsubscribeConnect = runtime.subscribeLifecycle('connect', () => onConnectLatest.current?.());
    const unsubscribeDisconnect = runtime.subscribeLifecycle('disconnect', () => onDisconnectLatest.current?.());

    return () => {
      unsubscribeConnect();
      unsubscribeDisconnect();
    };
  }, [onConnectLatest, onDisconnectLatest, runtime]);

  const sessionState: ExecutorSessionState = markHostedInternalExecutorSession(
    runtime.buildSessionState(debuggerConfig, connectionState),
  );

  return {
    sessionState,
    connect: (url: string) => {
      void runtime.connect(url);
    },
    disconnect: () => {
      runtime.disconnect();
    },
    send<T extends keyof OutgoingMessageMap>(type: T, data: OutgoingMessageMap[T]) {
      runtime.sendMessage(type, data);
    },
    sendRaw(data: string) {
      runtime.sendRaw(data);
    },
  };
}