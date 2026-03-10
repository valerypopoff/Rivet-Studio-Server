import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { startDebuggerServer, type RivetDebuggerServer } from '@ironclad/rivet-node';
import { WebSocketServer } from 'ws';

export const LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH = '/ws/latest-debugger';

let latestWorkflowRemoteDebugger: RivetDebuggerServer | null = null;
let latestWorkflowRemoteDebuggerUpgradeHandlerInitialized = false;

export function isLatestWorkflowRemoteDebuggerEnabled(): boolean {
  return process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER?.trim().toLowerCase() === 'true';
}

function getLatestWorkflowRemoteDebuggerToken(): string {
  const token = process.env.RIVET_LATEST_REMOTE_DEBUGGER_TOKEN?.trim();

  if (!token) {
    throw new Error('RIVET_LATEST_REMOTE_DEBUGGER_TOKEN must be set when RIVET_ENABLE_LATEST_REMOTE_DEBUGGER is true');
  }

  return token;
}

function getDebuggerRequestToken(requestUrl: string | undefined): string | null {
  const url = new URL(requestUrl ?? '', 'http://localhost');
  const token = url.searchParams.get('token')?.trim();
  return token || null;
}

function rejectWebSocketUpgrade(socket: Duplex, statusCode: 401 | 404, statusText: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function initializeLatestWorkflowRemoteDebugger(httpServer: HttpServer): RivetDebuggerServer | null {
  if (latestWorkflowRemoteDebugger) {
    return latestWorkflowRemoteDebugger;
  }

  const debuggerEnabled = isLatestWorkflowRemoteDebuggerEnabled();

  if (!debuggerEnabled && latestWorkflowRemoteDebuggerUpgradeHandlerInitialized) {
    return null;
  }

  const requiredToken = debuggerEnabled ? getLatestWorkflowRemoteDebuggerToken() : null;
  const webSocketServer = debuggerEnabled ? new WebSocketServer({ noServer: true }) : null;

  if (!latestWorkflowRemoteDebuggerUpgradeHandlerInitialized) {
    httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '', 'http://localhost');

      if (url.pathname !== LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH) {
        return;
      }

      if (!debuggerEnabled || !webSocketServer) {
        rejectWebSocketUpgrade(socket, 404, 'Not Found');
        return;
      }

      if (getDebuggerRequestToken(request.url) !== requiredToken) {
        rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      const handleUpgradeComplete = (webSocket: unknown) => {
        webSocketServer.emit('connection', webSocket, request);
      };

      webSocketServer.handleUpgrade(request, socket, head, handleUpgradeComplete);
    });

    latestWorkflowRemoteDebuggerUpgradeHandlerInitialized = true;
  }

  if (!debuggerEnabled || !webSocketServer) {
    return null;
  }

  latestWorkflowRemoteDebugger = startDebuggerServer({
    server: webSocketServer,
  });

  return latestWorkflowRemoteDebugger;
}

export function getLatestWorkflowRemoteDebugger(): RivetDebuggerServer {
  if (!latestWorkflowRemoteDebugger) {
    throw new Error('Latest workflow remote debugger has not been initialized');
  }

  return latestWorkflowRemoteDebugger;
}
