// Override for rivet/packages/app/src/hooks/useRemoteDebugger.ts
//
// ARCHITECTURE: Module-level WebSocket singleton + thin React hook wrapper.
// All socket management (connect, reconnect, send) lives outside React,
// eliminating stale-closure, multi-instance, and render-lifecycle races.

import { useLatest } from 'ahooks';
import { useAtom } from 'jotai';
import { remoteDebuggerState, type RemoteDebuggerState } from '../../../../rivet/packages/app/src/state/execution.js';
import { useEffect } from 'react';
import { match } from 'ts-pattern';
import { datasetProvider } from '../utils/globals/datasetProvider.js';
import { RIVET_DEBUG_LOGS, RIVET_REMOTE_DEBUGGER_DEFAULT_WS, RIVET_EXECUTOR_WS_URL } from '../../../shared/hosted-env';

// ─── Message handler (set by useRemoteExecutor) ─────────────────────────
let currentDebuggerMessageHandler: ((message: string, data: unknown) => void) | null = null;

type RemoteDebuggerStateValue = RemoteDebuggerState;
type RemoteDebuggerSetter = (value: RemoteDebuggerStateValue | ((prev: RemoteDebuggerStateValue) => RemoteDebuggerStateValue)) => void;

export function setCurrentDebuggerMessageHandler(handler: (message: string, data: unknown) => void) {
  currentDebuggerMessageHandler = handler;
}

// ─── Module-level WebSocket singleton ───────────────────────────────────
let ws: WebSocket | null = null;
let wsUrl = '';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 0;
let sharedRemoteDebuggerState: RemoteDebuggerStateValue = {
  socket: null,
  started: false,
  reconnecting: false,
  url: '',
  remoteUploadAllowed: false,
  isInternalExecutor: false,
};
const remoteDebuggerSubscribers = new Set<RemoteDebuggerSetter>();

function updateRemoteDebuggerState(
  value: RemoteDebuggerStateValue | ((prev: RemoteDebuggerStateValue) => RemoteDebuggerStateValue),
) {
  sharedRemoteDebuggerState = typeof value === 'function' ? value(sharedRemoteDebuggerState) : value;
  for (const subscriber of remoteDebuggerSubscribers) {
    subscriber(sharedRemoteDebuggerState);
  }
}

function syncRemoteDebuggerState(setState: RemoteDebuggerSetter) {
  remoteDebuggerSubscribers.add(setState);
  setState(sharedRemoteDebuggerState);

  return () => {
    remoteDebuggerSubscribers.delete(setState);
  };
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function cleanupSocket() {
  clearReconnectTimer();
  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }
}

function doConnect(url: string) {
  cleanupSocket();
  wsUrl = url || RIVET_REMOTE_DEBUGGER_DEFAULT_WS;
  const socket = new WebSocket(wsUrl);
  ws = socket;

  updateRemoteDebuggerState((prevState) => ({
    ...prevState,
    socket,
    started: true,
    reconnecting: false,
    url: wsUrl,
    remoteUploadAllowed: false,
    isInternalExecutor: wsUrl === RIVET_EXECUTOR_WS_URL,
  }));

  socket.onopen = () => {
    if (ws !== socket) return; // stale
    retryDelay = 0;
    hostedDebugLog('log', '[executor-ws] connected to', wsUrl);
    updateRemoteDebuggerState((prevState) => ({
      ...prevState,
      socket,
      reconnecting: false,
    }));
  };

  socket.onclose = () => {
    if (ws !== socket) return; // stale
    ws = null;
    // Auto-reconnect with exponential backoff (max 2 s)
    retryDelay = Math.min(2000, (retryDelay + 100) * 1.5);
    updateRemoteDebuggerState((prevState) => ({
      ...prevState,
      socket: null,
      started: false,
      reconnecting: true,
      remoteUploadAllowed: false,
    }));
    reconnectTimer = setTimeout(() => doConnect(wsUrl), retryDelay);
  };

  socket.onerror = () => {
    // onclose fires after onerror — reconnection handled there
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return; // stale
    const { message, data } = JSON.parse(event.data);

    if (message === 'graph-upload-allowed') {
      hostedDebugLog('log', '[executor-ws] graph upload allowed');
      updateRemoteDebuggerState((prevState) => ({
        ...prevState,
        remoteUploadAllowed: true,
      }));
    } else if (message.startsWith('datasets:')) {
      handleDatasetsMessage(message, data, socket);
    } else {
      currentDebuggerMessageHandler?.(message, data);
    }
  };
}

function doDisconnect() {
  cleanupSocket();
  retryDelay = 0;
  updateRemoteDebuggerState((prevState) => ({
    ...prevState,
    socket: null,
    started: false,
    reconnecting: false,
    remoteUploadAllowed: false,
  }));
}

function doSend(type: string, data: unknown) {
  const open = ws?.readyState === WebSocket.OPEN;
  hostedDebugLog('error', '[executor-ws] doSend type=%s open=%s', type, open);
  if (open) {
    ws!.send(JSON.stringify({ type, data }));
  }
}

function doSendRaw(data: string) {
  const open = ws?.readyState === WebSocket.OPEN;
  hostedDebugLog('error', '[executor-ws] doSendRaw open=%s len=%d', open, data.length);
  if (open) {
    ws!.send(data);
  }
}

function hostedDebugLog(method: 'log' | 'error', ...args: unknown[]) {
  if (!RIVET_DEBUG_LOGS) {
    return;
  }

  console[method](...args);
}

/** Call-time check — always reads the CURRENT socket, not a render-time capture. */
export function isExecutorConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

// ─── React hook: thin stable wrapper ────────────────────────────────────
//
// In hosted mode the executor container is always available. UI visibility
// (Run button) must NOT depend on transient WS connection state. The actual
// send helpers (doSend / doSendRaw) already guard against closed sockets,
// and tryRunGraph uses isExecutorConnected() at call time.

// !! DEBUG: this fires once when the module loads — proves override is in the bundle
hostedDebugLog('error', '%c[HOSTED-OVERRIDE] useRemoteDebugger module loaded (singleton)', 'color: magenta; font-weight: bold; font-size: 14px');

export function useRemoteDebugger(options: { onConnect?: () => void; onDisconnect?: () => void } = {}) {
  const [remoteDebugger, setRemoteDebuggerState] = useAtom(remoteDebuggerState);
  const onConnectLatest = useLatest(options.onConnect ?? (() => {}));
  const onDisconnectLatest = useLatest(options.onDisconnect ?? (() => {}));

  // !! DEBUG: fires every render — proves the hook is executing
  hostedDebugLog('error', '[HOSTED-OVERRIDE] useRemoteDebugger render: started=%s reconnecting=%s ws=%s', remoteDebugger.started, remoteDebugger.reconnecting, ws?.readyState);

  useEffect(() => syncRemoteDebuggerState(setRemoteDebuggerState), [setRemoteDebuggerState]);

  return {
    remoteDebuggerState: remoteDebugger,
    connect: (url: string) => {
      retryDelay = 0;
      onConnectLatest.current?.();
      doConnect(url);
    },
    disconnect: () => {
      doDisconnect();
      onDisconnectLatest.current?.();
    },
    send: doSend,
    sendRaw: doSendRaw,
  };
}

// ─── Dataset forwarding ─────────────────────────────────────────────────
async function handleDatasetsMessage(type: string, data: any, socket: WebSocket) {
  const { requestId, payload } = data;
  await match(type)
    .with('datasets:get-metadata', async () => {
      const metadata = await datasetProvider.getDatasetMetadata(payload.id);
      socket.send(
        JSON.stringify({
          type: 'datasets:response',
          data: {
            requestId,
            payload: metadata,
          },
        }),
      );
    })
    .with('datasets:get-for-project', async () => {
      const metadata = await datasetProvider.getDatasetsForProject(payload.projectId);
      socket.send(
        JSON.stringify({
          type: 'datasets:response',
          data: {
            requestId,
            payload: metadata,
          },
        }),
      );
    })
    .with('datasets:get-data', async () => {
      const data = await datasetProvider.getDatasetData(payload.id);
      socket.send(
        JSON.stringify({
          type: 'datasets:response',
          data: {
            requestId,
            payload: data,
          },
        }),
      );
    })
    .with('datasets:put-data', async () => {
      await datasetProvider.putDatasetData(payload.id, payload.data);
      socket.send(
        JSON.stringify({
          type: 'datasets:response',
          data: {
            requestId,
            payload: undefined,
          },
        }),
      );
    })
    .with('datasets:put-row', async () => {
      await datasetProvider.putDatasetRow(payload.id, payload.row);
      socket.send(
        JSON.stringify({
          type: 'datasets:response',
          data: {
            requestId,
            payload: undefined,
          },
        }),
      );
    })
    .with('datasets:put-metadata', async () => {
      await datasetProvider.putDatasetMetadata(payload.metadata);
      socket.send(
        JSON.stringify({
          type: 'datasets:response',
          data: {
            requestId,
            payload: undefined,
          },
        }),
      );
    })
    .with('datasets:clear-data', async () => {
      await datasetProvider.clearDatasetData(payload.id);
      socket.send(
        JSON.stringify({
          type: 'datasets:response',
          data: {
            requestId,
            payload: undefined,
          },
        }),
      );
    })
    .with('datasets:delete', async () => {
      await datasetProvider.deleteDataset(payload.id);
      socket.send(
        JSON.stringify({
          type: 'datasets:response',
          data: {
            requestId,
            payload: undefined,
          },
        }),
      );
    })
    .with('datasets:knn', async () => {
      const nearest = await datasetProvider.knnDatasetRows(payload.datasetId, payload.k, payload.vector);
      socket.send(
        JSON.stringify({
          type: 'datasets:response',
          data: {
            requestId,
            payload: nearest,
          },
        }),
      );
    })
    .otherwise(() => {
      console.error(`Unknown datasets message type: ${type}`);
    });
}
