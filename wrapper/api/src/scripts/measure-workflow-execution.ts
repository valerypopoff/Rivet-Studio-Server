import { performance } from 'node:perf_hooks';

type WorkflowExecutionKind = 'published' | 'latest';

type ParsedArgs = {
  baseUrl: string;
  endpoint: string;
  kind: WorkflowExecutionKind;
  runs: number;
  warmups: number;
  body: string;
  bearer: string | null;
};

function printUsage(): void {
  console.error(
    'Usage: npm --prefix wrapper/api run workflow-execution:measure -- ' +
    '--base-url http://localhost:8081 --endpoint hello-world --kind published|latest ' +
    '[--runs 5] [--warmups 1] [--body \'{}\'] [--bearer token]',
  );
}

function parseIntegerOption(value: string, optionName: string, fallback: number): number {
  if (!value.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${optionName}: ${value}`);
  }

  return parsed;
}

function parseArgs(argv: string[]): ParsedArgs {
  const options = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex >= 0) {
      options.set(token.slice(2, equalsIndex), token.slice(equalsIndex + 1));
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith('--')) {
      options.set(key, '');
      continue;
    }

    options.set(key, next);
    index += 1;
  }

  const baseUrl = options.get('base-url')?.trim() ?? '';
  const endpoint = options.get('endpoint')?.trim() ?? '';
  const kind = options.get('kind')?.trim() as WorkflowExecutionKind | undefined;
  if (!baseUrl || !endpoint || (kind !== 'published' && kind !== 'latest')) {
    throw new Error('Missing required options: --base-url, --endpoint, --kind');
  }

  const body = options.get('body')?.trim() || '{}';
  JSON.parse(body);

  return {
    baseUrl,
    endpoint,
    kind,
    runs: parseIntegerOption(options.get('runs') ?? '', '--runs', 5),
    warmups: parseIntegerOption(options.get('warmups') ?? '', '--warmups', 1),
    body,
    bearer: options.get('bearer')?.trim() || null,
  };
}

function buildExecutionUrl(baseUrl: string, kind: WorkflowExecutionKind, endpoint: string): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const routePrefix = kind === 'published' ? 'workflows' : 'workflows-latest';
  return new URL(`${routePrefix}/${encodeURIComponent(endpoint)}`, normalizedBaseUrl).toString();
}

function formatHeaderValue(value: string | null): string {
  return value?.trim() || 'n/a';
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    printUsage();
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const executionUrl = buildExecutionUrl(args.baseUrl, args.kind, args.endpoint);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (args.bearer) {
    headers.Authorization = `Bearer ${args.bearer}`;
  }

  const totalRequests = args.warmups + args.runs;
  for (let index = 0; index < totalRequests; index += 1) {
    const startedAt = performance.now();
    const response = await fetch(executionUrl, {
      method: 'POST',
      headers,
      body: args.body,
    });
    await response.text();
    const totalClientMs = Math.max(0, Math.round(performance.now() - startedAt));

    const label = index < args.warmups
      ? `warmup ${index + 1}/${args.warmups}`
      : `run ${index + 1 - args.warmups}/${args.runs}`;
    console.log(
      [
        `[${label}]`,
        `status=${response.status}`,
        `total-client-ms=${totalClientMs}`,
        `x-duration-ms=${formatHeaderValue(response.headers.get('x-duration-ms'))}`,
        `x-workflow-resolve-ms=${formatHeaderValue(response.headers.get('x-workflow-resolve-ms'))}`,
        `x-workflow-materialize-ms=${formatHeaderValue(response.headers.get('x-workflow-materialize-ms'))}`,
        `x-workflow-execute-ms=${formatHeaderValue(response.headers.get('x-workflow-execute-ms'))}`,
        `x-workflow-cache=${formatHeaderValue(response.headers.get('x-workflow-cache'))}`,
      ].join(' '),
    );
  }
}

await main();
