import type { RemoteDebuggerState } from '../../../../rivet/packages/app/src/state/execution.js';
import { logHostedDebug, RIVET_EXECUTOR_WS_URL, RIVET_REMOTE_DEBUGGER_DEFAULT_WS } from '../../../shared/hosted-env';
import { handleRemoteDebuggerDatasetsMessage } from './remoteDebuggerDatasets';

type RemoteDebuggerStateValue = RemoteDebuggerState;
type RemoteDebuggerSetter = (value: RemoteDebuggerStateValue | ((prev: RemoteDebuggerStateValue) => RemoteDebuggerStateValue)) => void;

let currentDebuggerMessageHandler: ((message: string, data: unknown) => void) | null = null;
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

export function setCurrentDebuggerMessageHandler(handler: ((message: string, data: unknown) => void) | null) {
  currentDebuggerMessageHandler = handler;
}

export function syncRemoteDebuggerState(setState: RemoteDebuggerSetter) {
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

export function connectRemoteDebugger(url: string) {
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
    if (ws !== socket) {
      return;
    }

    retryDelay = 0;
    logHostedDebug('log', '[executor-ws] connected to', wsUrl);
    updateRemoteDebuggerState((prevState) => ({
      ...prevState,
      socket,
      reconnecting: false,
    }));
  };

  socket.onclose = () => {
    if (ws !== socket) {
      return;
    }

    ws = null;
    retryDelay = Math.min(2000, (retryDelay + 100) * 1.5);
    updateRemoteDebuggerState((prevState) => ({
      ...prevState,
      socket: null,
      started: false,
      reconnecting: true,
      remoteUploadAllowed: false,
    }));
    reconnectTimer = setTimeout(() => connectRemoteDebugger(wsUrl), retryDelay);
  };

  socket.onerror = () => {
    // onclose fires after onerror; reconnect is handled there
  };

  socket.onmessage = (event) => {
    if (ws !== socket) {
      return;
    }

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
      return;
    }

    if (message.startsWith('datasets:')) {
      void handleRemoteDebuggerDatasetsMessage(message, data, socket).catch((error) => {
        console.error('Failed to handle datasets message:', error);
      });
      return;
    }

    currentDebuggerMessageHandler?.(message, data);
  };
}

export function disconnectRemoteDebugger() {
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

export function sendRemoteDebuggerMessage(type: string, data: unknown) {
  const open = ws?.readyState === WebSocket.OPEN;
  logHostedDebug('log', '[executor-ws] doSend type=%s open=%s', type, open);
  if (open) {
    ws!.send(JSON.stringify({ type, data }));
  }
}

export function sendRemoteDebuggerRaw(data: string) {
  const open = ws?.readyState === WebSocket.OPEN;
  logHostedDebug('log', '[executor-ws] doSendRaw open=%s len=%d', open, data.length);
  if (open) {
    ws!.send(data);
  }
}

export function isExecutorConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}
