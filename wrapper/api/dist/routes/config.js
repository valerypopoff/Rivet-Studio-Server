import { Router } from 'express';
export const configRouter = Router();
// GET /api/config — return runtime configuration
configRouter.get('/config', (_req, res) => {
    res.json({
        hostedMode: true,
        executorWsUrl: process.env.RIVET_EXECUTOR_WS_URL ?? 'ws://localhost/ws/executor/internal',
        remoteDebuggerDefaultWs: process.env.RIVET_REMOTE_DEBUGGER_DEFAULT_WS ?? 'ws://localhost/ws/executor',
        apiBaseUrl: '/api',
    });
});
