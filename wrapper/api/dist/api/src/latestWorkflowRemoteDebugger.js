import { startDebuggerServer } from '@ironclad/rivet-node';
import { WebSocketServer } from 'ws';
export const LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH = '/ws/latest-debugger';
let latestWorkflowRemoteDebugger = null;
let latestWorkflowRemoteDebuggerUpgradeHandlerInitialized = false;
export function isLatestWorkflowRemoteDebuggerEnabled() {
    return process.env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER?.trim().toLowerCase() === 'true';
}
function rejectWebSocketUpgrade(socket, statusCode, statusText) {
    socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
}
export function initializeLatestWorkflowRemoteDebugger(httpServer) {
    if (latestWorkflowRemoteDebugger) {
        return latestWorkflowRemoteDebugger;
    }
    const debuggerEnabled = isLatestWorkflowRemoteDebuggerEnabled();
    if (!debuggerEnabled && latestWorkflowRemoteDebuggerUpgradeHandlerInitialized) {
        return null;
    }
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
            const handleUpgradeComplete = (webSocket) => {
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
export function getLatestWorkflowRemoteDebugger() {
    if (!latestWorkflowRemoteDebugger) {
        throw new Error('Latest workflow remote debugger has not been initialized');
    }
    return latestWorkflowRemoteDebugger;
}
