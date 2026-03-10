import './loadRootEnv.js';

function normalizeWorkflowBasePath(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  const candidate = trimmed && trimmed.length > 0 ? trimmed : fallback;
  const withLeadingSlash = candidate.startsWith('/') ? candidate : `/${candidate}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  return withoutTrailingSlash || fallback;
}

export const PUBLISHED_WORKFLOWS_BASE_PATH = normalizeWorkflowBasePath(
  process.env.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH,
  '/workflows',
);

export const LATEST_WORKFLOWS_BASE_PATH = normalizeWorkflowBasePath(
  process.env.RIVET_LATEST_WORKFLOWS_BASE_PATH,
  '/workflows-last',
);
