import type { Server as HttpServer } from 'node:http';
import { type RivetDebuggerServer } from '@ironclad/rivet-node';
export declare const LATEST_WORKFLOW_REMOTE_DEBUGGER_PATH = "/ws/latest-debugger";
export declare function isLatestWorkflowRemoteDebuggerEnabled(): boolean;
export declare function initializeLatestWorkflowRemoteDebugger(httpServer: HttpServer): RivetDebuggerServer | null;
export declare function getLatestWorkflowRemoteDebugger(): RivetDebuggerServer;
