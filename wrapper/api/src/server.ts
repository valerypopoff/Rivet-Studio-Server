import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { nativeRouter } from './routes/native.js';
import { shellRouter } from './routes/shell.js';
import { pluginsRouter } from './routes/plugins.js';
import { projectsRouter } from './routes/projects.js';
import { latestWorkflowsRouter, publishedWorkflowsRouter, workflowsRouter } from './routes/workflows/index.js';
import { configRouter } from './routes/config.js';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3100', 10);

app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Mount routes
app.use('/workflows', publishedWorkflowsRouter);
app.use('/workflows-last', latestWorkflowsRouter);
app.use('/api/native', nativeRouter);
app.use('/api/shell', shellRouter);
app.use('/api/plugins', pluginsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/workflows', workflowsRouter);
app.use('/api', configRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as any).status ?? 500;
  console.error('Unhandled API error:', err);
  res.status(status).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`[rivet-api] Listening on port ${PORT}`);
  console.log(`[rivet-api] Workspace root: ${process.env.RIVET_WORKSPACE_ROOT ?? '/workspace'}`);
  console.log(`[rivet-api] App data root: ${process.env.RIVET_APP_DATA_ROOT ?? '/data/rivet-app'}`);
});
