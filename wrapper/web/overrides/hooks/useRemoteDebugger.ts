// Override for rivet/packages/app/src/hooks/useRemoteDebugger.ts
//
// ARCHITECTURE: Module-level WebSocket singleton + thin React hook wrapper.
// All socket management lives in remoteDebuggerClient.ts so React only
// subscribes to shared state and forwards intent.

import { useLatest } from 'ahooks';
import { useAtom } from 'jotai';
import { useEffect } from 'react';
import { remoteDebuggerState } from '../../../../rivet/packages/app/src/state/execution.js';
import {
  connectRemoteDebugger,
  disconnectRemoteDebugger,
  isExecutorConnected,
  sendRemoteDebuggerMessage,
  sendRemoteDebuggerRaw,
  setCurrentDebuggerMessageHandler,
  syncRemoteDebuggerState,
} from './remoteDebuggerClient';

export { isExecutorConnected, setCurrentDebuggerMessageHandler };

export function useRemoteDebugger(options: { onConnect?: () => void; onDisconnect?: () => void } = {}) {
  const [remoteDebugger, setRemoteDebuggerState] = useAtom(remoteDebuggerState);
  const onConnectLatest = useLatest(options.onConnect ?? (() => {}));
  const onDisconnectLatest = useLatest(options.onDisconnect ?? (() => {}));

  useEffect(() => syncRemoteDebuggerState(setRemoteDebuggerState), [setRemoteDebuggerState]);

  return {
    remoteDebuggerState: remoteDebugger,
    connect: (url: string) => {
      onConnectLatest.current?.();
      connectRemoteDebugger(url);
    },
    disconnect: () => {
      disconnectRemoteDebugger();
      onDisconnectLatest.current?.();
    },
    send: sendRemoteDebuggerMessage,
    sendRaw: sendRemoteDebuggerRaw,
  };
}
