// Override for rivet/packages/app/src/hooks/useRemoteDebugger.ts
//
// ARCHITECTURE: Module-level WebSocket singleton + thin React hook wrapper.
// All socket management (connect, reconnect, send) lives outside React,
// eliminating stale-closure, multi-instance, and render-lifecycle races.

import { useLatest } from 'ahooks';
import { useAtom } from 'jotai';
import { remoteDebuggerState, type RemoteDebuggerState } from '../../../../rivet/packages/app/src/state/execution.js';
import { useEffect } from 'react';
import { datasetProvider } from '../../../../rivet/packages/app/src/utils/globals/datasetProvider';
import { logHostedDebug, RIVET_REMOTE_DEBUGGER_DEFAULT_WS, RIVET_EXECUTOR_WS_URL } from '../../../shared/hosted-env';

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
  const nextUrl = url || RIVET_REMOTE_DEBUGGER_DEFAULT_WS;

  if (ws && wsUrl === nextUrl && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  cleanupSocket();
  wsUrl = nextUrl;
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
    logHostedDebug('log', '[executor-ws] connected to', wsUrl);
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
    const parsed = JSON.parse(event.data) as { message?: string; type?: string; data?: unknown };
    const message = parsed.message ?? parsed.type;
    const data = parsed.data;

    if (!message) {
      return;
    }

    if (message === 'graph-upload-allowed') {
      logHostedDebug('log', '[executor-ws] graph upload allowed');
      updateRemoteDebuggerState((prevState) => ({
        ...prevState,
        remoteUploadAllowed: true,
      }));
    } else if (message.startsWith('datasets:')) {
      void handleDatasetsMessage(message, data, socket).catch((error) => {
        console.error('Failed to handle datasets message:', error);
      });
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
  logHostedDebug('log', '[executor-ws] doSend type=%s open=%s', type, open);
  if (open) {
    ws!.send(JSON.stringify({ type, data }));
  }
}

function doSendRaw(data: string) {
  const open = ws?.readyState === WebSocket.OPEN;
  logHostedDebug('log', '[executor-ws] doSendRaw open=%s len=%d', open, data.length);
  if (open) {
    ws!.send(data);
  }
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

export function useRemoteDebugger(options: { onConnect?: () => void; onDisconnect?: () => void } = {}) {
  const [remoteDebugger, setRemoteDebuggerState] = useAtom(remoteDebuggerState);
  const onConnectLatest = useLatest(options.onConnect ?? (() => {}));
  const onDisconnectLatest = useLatest(options.onDisconnect ?? (() => {}));

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
const datasetHandlers: Record<string, (p: any) => Promise<unknown>> = {
  'datasets:get-metadata': (p) => datasetProvider.getDatasetMetadata(p.id),
  'datasets:get-for-project': (p) => datasetProvider.getDatasetsForProject(p.projectId),
  'datasets:get-data': (p) => datasetProvider.getDatasetData(p.id),
  'datasets:put-data': (p) => datasetProvider.putDatasetData(p.id, p.data),
  'datasets:put-row': (p) => datasetProvider.putDatasetRow(p.id, p.row),
  'datasets:put-metadata': (p) => datasetProvider.putDatasetMetadata(p.metadata),
  'datasets:clear-data': (p) => datasetProvider.clearDatasetData(p.id),
  'datasets:delete': (p) => datasetProvider.deleteDataset(p.id),
  'datasets:knn': (p) => datasetProvider.knnDatasetRows(p.datasetId, p.k, p.vector),
};

async function handleDatasetsMessage(type: string, data: any, socket: WebSocket) {
  const handler = datasetHandlers[type];
  if (!handler) {
    console.error(`Unknown datasets message type: ${type}`);
    return;
  }
  const { requestId, payload } = data;
  const result = await handler(payload);
  socket.send(JSON.stringify({
    type: 'datasets:response',
    data: { requestId, payload: result },
  }));
}
