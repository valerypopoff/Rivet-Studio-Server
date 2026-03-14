import { normalizeBasePath } from '../../shared/normalize-base-path.js';
export const PUBLISHED_WORKFLOWS_BASE_PATH = normalizeBasePath(process.env.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH, '/workflows');
export const LATEST_WORKFLOWS_BASE_PATH = normalizeBasePath(process.env.RIVET_LATEST_WORKFLOWS_BASE_PATH, '/workflows-latest');
