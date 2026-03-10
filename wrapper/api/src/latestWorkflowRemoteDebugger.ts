import type { Server as HttpServer } from 'node:http';
import { startDebuggerServer, type RivetDebuggerServer } from '@ironclad/rivet-node';
import { WebSocketServer } from 'ws';

export const LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH = '/ws/latest-debugger';

let latestWorkflowRemoteDebugger: RivetDebuggerServer | null = null;

export function initializeLatestWorkflowRemoteDebugger(httpServer: HttpServer): RivetDebuggerServer {
  if (latestWorkflowRemoteDebugger) {
    return latestWorkflowRemoteDebugger;
  }

  latestWorkflowRemoteDebugger = startDebuggerServer({
    server: new WebSocketServer({
      server: httpServer,
      path: LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH,
    }),
  });

  return latestWorkflowRemoteDebugger;
}

export function getLatestWorkflowRemoteDebugger(): RivetDebuggerServer {
  if (!latestWorkflowRemoteDebugger) {
    throw new Error('Latest workflow remote debugger has not been initialized');
  }

  return latestWorkflowRemoteDebugger;
}
