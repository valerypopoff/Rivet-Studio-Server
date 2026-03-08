# Refactor Plan

This plan keeps every feature listed in `description.md` and every constraint in `findings-and-problems.md`. Each change states what it removes or simplifies and why the feature still works afterwards.

No files inside `rivet/` are touched by any item in this plan.

---

## 1. Remove dead code — DONE

### 1a. Delete `wrapper/web/dashboard/WorkflowDashboardShell.tsx` — DONE

This file is not imported by any other file. It was an earlier layout approach (non-iframe shell around the editor) superseded by the current `DashboardPage` + iframe model. Grep for `WorkflowDashboardShell` across the repo confirms zero imports.

**Files changed:** delete `wrapper/web/dashboard/WorkflowDashboardShell.tsx`.

### 1b. Delete `wrapper/web/overrides/components/RivetApp.tsx` — DONE

This file contains a single line: `export { RivetApp } from '../../../../rivet/packages/app/src/components/RivetApp';`. It is a pure re-export with zero modifications. There is no Vite alias pointing to it (confirmed by inspecting `vite.config.ts`), and the only consumer (`HostedEditorApp.tsx`) imports `RivetApp` directly from the upstream path, not through this override.

**Files changed:** delete `wrapper/web/overrides/components/RivetApp.tsx`.

### 1c. Rename `yamlString()` in `wrapper/api/src/routes/workflows.ts` — DONE

The function on line 419 is named `yamlString` but its body is `return JSON.stringify(value)`. This is confusing — it is used to produce a JSON-quoted string for embedding in a YAML template. Rename to `quoteForYaml` and add a one-line comment.

**Files changed:** `wrapper/api/src/routes/workflows.ts` — rename function and its 5 call sites (lines 431, 432, 434, 436, 438).

### 1d. Fix debug log severity in `wrapper/web/overrides/hooks/useRemoteDebugger.ts` — DONE

Lines 157, 165, 184, 192 use `logHostedDebug('error', ...)` for non-error diagnostic messages. Change the first argument to `'log'` so that when debug logging is enabled, these do not appear as red console errors.

**Files changed:** `wrapper/web/overrides/hooks/useRemoteDebugger.ts` — change `'error'` to `'log'` in 4 `logHostedDebug` calls.

**Feature safety:** No runtime behavior changes. Debug log level does not affect control flow.

---

## 2. Simplify `useOpenWorkflowProject.ts` — DONE

### Problem

In `wrapper/web/dashboard/useOpenWorkflowProject.ts`, the `setProjects()` call (lines 85-107) contains a deeply nested ternary expression that filters `prev.openedProjectsSortedIds` three separate times with the identical `filter(id => id !== currentProject.metadata.id)` logic.

### Change

Inside the `setProjects` updater function, extract the filtered list into a local variable:

```ts
setProjects((prev: OpenedProjectsInfo) => {
  const filteredSortedIds = replaceCurrent
    ? prev.openedProjectsSortedIds.filter(id => id !== currentProject.metadata.id)
    : prev.openedProjectsSortedIds;

  const nextSortedIds = filteredSortedIds.includes(project.metadata.id)
    ? filteredSortedIds
    : [...filteredSortedIds, project.metadata.id];

  return {
    openedProjects: {
      ...(replaceCurrent
        ? Object.fromEntries(
            Object.entries(prev.openedProjects).filter(([id]) => id !== currentProject.metadata.id),
          )
        : prev.openedProjects),
      [project.metadata.id]: projectInfo,
    },
    openedProjectsSortedIds: nextSortedIds,
  };
});
```

**Files changed:** `wrapper/web/dashboard/useOpenWorkflowProject.ts` — replace lines 85-107.

**Feature safety:** Produces the exact same `openedProjects` map and `openedProjectsSortedIds` array. Only the structure of the code changes, not the computation.

---

## 3. Extract shared API helpers (`wrapper/shared/api.ts`) — DONE

### Problem

`wrapper/web/io/HostedIOProvider.ts` (lines 24-69) and `wrapper/web/overrides/io/datasets.ts` (lines 10-39) each define their own copies of `apiReadText`, `apiWriteText`, and `apiExists` with identical fetch-POST-parse logic.

Note: `wrapper/web/dashboard/workflowApi.ts` is NOT included in this extraction — it calls different endpoints (`/workflows/*`) and has its own `parseJsonResponse` helper with HTML-detection logic specific to workflow proxy routing issues. That difference is intentional and should stay.

### Change

Create `wrapper/shared/api.ts`:

```ts
import { RIVET_API_BASE_URL } from './hosted-env';

const API = RIVET_API_BASE_URL;

export async function apiReadText(path: string): Promise<string> {
  const resp = await fetch(`${API}/native/read-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) throw new Error(`Failed to read file: ${resp.statusText}`);
  const data = await resp.json();
  return data.contents;
}

export async function apiWriteText(path: string, contents: string): Promise<void> {
  const resp = await fetch(`${API}/native/write-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, contents }),
  });
  if (!resp.ok) throw new Error(`Failed to write file: ${resp.statusText}`);
}

export async function apiReadBinary(path: string): Promise<Uint8Array> {
  const resp = await fetch(`${API}/native/read-binary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) throw new Error(`Failed to read binary file: ${resp.statusText}`);
  const data = await resp.json();
  const binary = atob(data.contents);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function apiExists(path: string): Promise<boolean> {
  const resp = await fetch(`${API}/native/exists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) return false;
  const data = await resp.json();
  return data.exists;
}
```

Then:
- In `wrapper/web/io/HostedIOProvider.ts`: delete the local `apiReadText`, `apiWriteText`, `apiReadBinary`, `apiExists` functions (lines 24-69) and the local `API` constant (line 22). Add `import { apiReadText, apiWriteText, apiReadBinary, apiExists } from '../../shared/api';`. Keep `apiListProjects` in place (it calls a different endpoint).
- In `wrapper/web/overrides/io/datasets.ts`: delete the local `apiReadText`, `apiWriteText`, `apiExists` functions (lines 10-39) and the local `API` constant (line 8). Add `import { apiReadText, apiWriteText, apiExists } from '../../../shared/api';`.

**Files changed:**
- Create `wrapper/shared/api.ts`
- Edit `wrapper/web/io/HostedIOProvider.ts`
- Edit `wrapper/web/overrides/io/datasets.ts`

**Estimated reduction:** ~50 lines removed across the two consumer files.

**Feature safety:** Same HTTP calls to the same endpoints with the same error handling. The `RIVET_API_BASE_URL` import source is the same (`hosted-env.ts`).

---

## 4. Deduplicate `parseEnvFile` across scripts — DONE

### Problem

`scripts/dev.mjs`, `scripts/dev-docker.mjs`, and `scripts/run-with-env.mjs` each contain their own `parseEnvFile` implementation. `dev-docker.mjs` handles quoted values (strips surrounding `"` or `'`); the other two do not.

### Change

Create `scripts/lib/env.mjs` exporting the `parseEnvFile` function. Use the version from `dev-docker.mjs` (lines 8-37, which handles quoted values) as the canonical implementation:

```js
import fs from 'node:fs';

export function parseEnvFile(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;

  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}
```

Then update all three scripts:
- `scripts/dev.mjs`: delete local `parseEnvFile` (lines 8-29), add `import { parseEnvFile } from './lib/env.mjs';`
- `scripts/dev-docker.mjs`: delete local `parseEnvFile` (lines 8-37), add `import { parseEnvFile } from './lib/env.mjs';`
- `scripts/run-with-env.mjs`: delete local `parseEnvFile` (lines 8-29), add `import { parseEnvFile } from './lib/env.mjs';`

**Files changed:**
- Create `scripts/lib/env.mjs`
- Edit `scripts/dev.mjs`
- Edit `scripts/dev-docker.mjs`
- Edit `scripts/run-with-env.mjs`

**Estimated reduction:** ~40 lines.

**Feature safety:** The canonical version (from `dev-docker.mjs`) is a strict superset of the other two — it handles everything they handle plus quoted values. `dev-docker.mjs` still resolves `RIVET_WORKFLOWS_HOST_PATH` after calling the shared parser (respects finding 15).

---

## 5. Deduplicate command execution between `plugins.ts` and `shell.ts` — DONE

### Problem

`wrapper/api/src/routes/plugins.ts` has a `runCommand()` function (lines 207-228) and `wrapper/api/src/routes/shell.ts` has `execCommand()` (lines 39-80). Both spawn a child process with a timeout and collect stdout/stderr, but they differ:

- `shell.ts` tracks byte counts and truncates output at a configurable `maxOutput` limit
- `plugins.ts` collects all output without byte limits and uses a hardcoded 120s timeout

### Change

Extract to `wrapper/api/src/utils/exec.ts`:

```ts
import { spawn } from 'node:child_process';

interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number; // omit to collect all output
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function execCommand(
  program: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(program, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxOutput = options.maxOutputBytes ?? Infinity;

    proc.stdout.on('data', (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes <= maxOutput) stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes <= maxOutput) stderr += data.toString();
    });

    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    proc.on('error', reject);
  });
}
```

Then:
- In `shell.ts`: delete local `execCommand` function (lines 39-80) and `ExecResult` interface (lines 33-37). Add `import { execCommand } from '../utils/exec.js';`. The route handler passes `{ cwd, timeoutMs: timeout, maxOutputBytes: maxOutput }`.
- In `plugins.ts`: delete local `runCommand` function (lines 207-228). Add `import { execCommand } from '../utils/exec.js';`. Change the call on line 147 from `runCommand('pnpm', [...], { cwd })` to `execCommand('pnpm', [...], { cwd: pluginFilesPath, timeoutMs: 120_000 })`.

**Files changed:**
- Create `wrapper/api/src/utils/exec.ts`
- Edit `wrapper/api/src/routes/shell.ts`
- Edit `wrapper/api/src/routes/plugins.ts`

**Estimated reduction:** ~30 lines.

**Feature safety:** `shell.ts` still gets byte-limited output (passes `maxOutputBytes`). `plugins.ts` still gets unlimited output (omits `maxOutputBytes`, defaults to `Infinity`). Same spawn semantics.

---

## 6. Merge `config.ts` and `path.ts` API routes — DONE

### Problem

`wrapper/api/src/routes/config.ts` (13 lines) and `wrapper/api/src/routes/path.ts` (15 lines) are trivial single-purpose route files. Together they add two Express router registrations to `server.ts` for minimal content.

### Change

Move the path endpoints into `config.ts`. Since `configRouter` is currently mounted at `/api` in `server.ts` (line 26), and `pathRouter` is currently mounted at `/api/path` (line 22), the merged router needs to define routes that produce the same URL paths:

In `wrapper/api/src/routes/config.ts`, add:

```ts
import path from 'node:path';
import { getAppDataRoot } from '../security.js';

// existing:
configRouter.get('/config', (_req, res) => { ... });

// moved from path.ts:
configRouter.get('/path/app-local-data-dir', (_req, res) => {
  res.json({ path: getAppDataRoot() });
});

configRouter.get('/path/app-log-dir', (_req, res) => {
  res.json({ path: path.join(getAppDataRoot(), 'logs') });
});
```

Then:
- Delete `wrapper/api/src/routes/path.ts`.
- In `wrapper/api/src/server.ts`: remove the `pathRouter` import (line 6) and its `app.use('/api/path', pathRouter)` mount (line 22).

The resulting URLs are identical: `GET /api/config`, `GET /api/path/app-local-data-dir`, `GET /api/path/app-log-dir`.

**Files changed:**
- Edit `wrapper/api/src/routes/config.ts`
- Delete `wrapper/api/src/routes/path.ts`
- Edit `wrapper/api/src/server.ts`

**Estimated reduction:** ~15 lines + one fewer import.

**Feature safety:** Same URLs, same response bodies. The frontend Tauri shims call these endpoints by exact URL, which does not change.

---

## 7. Consolidate API error handling — DONE

### Problem

Every route handler in `wrapper/api/` repeats the same `try { ... } catch (err: any) { res.status(400).json({ error: err.message }); }` pattern. This is ~50 lines of repeated boilerplate across 8 route files.

### Change

**IMPORTANT: Express 4 does NOT automatically catch errors thrown from `async` route handlers.** Simply removing `try/catch` blocks without adding a wrapper would cause unhandled promise rejections that crash the server. One of the two approaches below is mandatory:

**Option A (recommended — zero new dependencies):** Add a small `asyncHandler` wrapper in `wrapper/api/src/utils/asyncHandler.ts`:

```ts
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
```

**Option B:** Install the `express-async-errors` package and import it at the top of `server.ts`. This monkey-patches Express to auto-forward async errors.

Then add error-handling middleware at the bottom of `server.ts` (after all route mounts):

```ts
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as any).status ?? 500;
  console.error('Unhandled API error:', err);
  res.status(status).json({ error: err.message });
});
```

With either option, route handlers can drop their outer `try/catch` and use `asyncHandler(async (req, res) => { ... })` instead of `async (req, res) => { try { ... } catch { ... } }`.

Routes that need specific status codes (like `workflows.ts` returning 409 for conflicts) keep their explicit `res.status(409).json(...)` calls — those return before any throw happens, so the catch middleware is not involved.

**Files changed:**
- Create `wrapper/api/src/utils/asyncHandler.ts` (option A)
- Edit `wrapper/api/src/server.ts` (add error middleware)
- Edit all route files to wrap handlers and remove outer try/catch

**Estimated reduction:** ~40 lines of identical catch blocks.

**Feature safety:** Same JSON error shape. Same status codes for handled cases (409, 403, etc.). Unhandled errors now return 500 JSON instead of Express's default HTML error page.

---

## 8. Simplify `useSyncCurrentStateIntoOpenedProjects.ts` — DONE

### Problem

`wrapper/web/overrides/hooks/useSyncCurrentStateIntoOpenedProjects.ts` uses 5 separate `useEffect` calls with overlapping dependency arrays. A local `prevProjectState` React state tracks previous project data across renders.

### Risk assessment

**This is the highest-risk item in the plan.** The current effects fire in very specific sequences based on their dependency arrays. Combining effects or switching `useState` to `useRef` for `prevProjectState` changes the timing of when state updates occur relative to React renders. Multi-tab project switching, graph editing, and the save-path synchronization (finding 17) all depend on these effects firing correctly.

### Change (conservative approach)

Do NOT combine effects or change `useState` to `useRef`. Instead, make two targeted improvements:

1. **Add comments** to each `useEffect` explaining its specific responsibility and why it has the dependencies it has.
2. **Suppress the ESLint exhaustive-deps warning** on effect 3 (line 53, `[currentProject]` deps) with an explicit `// eslint-disable-next-line` and a comment explaining that broader deps would cause extra re-syncs.

This preserves the existing timing behavior while making the code understandable for future changes.

**Files changed:** `wrapper/web/overrides/hooks/useSyncCurrentStateIntoOpenedProjects.ts` — add comments only.

**Feature safety:** No behavioral change.

---

## 9. Extract CSS out of component files — DONE

### Problem

`wrapper/web/dashboard/DashboardPage.tsx` has 111 lines of CSS in a template string (lines 15-126). `wrapper/web/dashboard/WorkflowLibraryPanel.tsx` has 225 lines (lines 34-259). Both inject CSS via `<style>{styles}</style>`. This was a deliberate choice to avoid Emotion runtime crashes (finding 14). The approach works but buries CSS inside component files.

### Change

Move each CSS block to a co-located `.css` file:

- Move `DashboardPage.tsx` lines 15-126 (the `styles` template string content) to `wrapper/web/dashboard/DashboardPage.css`
- Move `WorkflowLibraryPanel.tsx` lines 34-259 (the `styles` template string content) to `wrapper/web/dashboard/WorkflowLibraryPanel.css`

In each component:
- Delete the `const styles = \`...\`;` declaration
- Delete the `<style>{styles}</style>` element from the JSX return
- Add a CSS import at the top: `import './DashboardPage.css';` / `import './WorkflowLibraryPanel.css';`

Vite handles CSS imports natively — no additional plugin needed.

Note: `entry.tsx` uses dynamic `await import()` for both `DashboardPage` and `HostedEditorApp`, so the dashboard CSS will only be loaded on the non-editor route. It will not leak into the `/?editor` iframe.

The selectors already use `.dashboard-page` and `.workflow-library-panel` class prefixes for scoping, so there is no risk of style collision.

**Files changed:**
- Create `wrapper/web/dashboard/DashboardPage.css`
- Create `wrapper/web/dashboard/WorkflowLibraryPanel.css`
- Edit `wrapper/web/dashboard/DashboardPage.tsx`
- Edit `wrapper/web/dashboard/WorkflowLibraryPanel.tsx`

**Estimated reduction:** ~340 lines moved out of TSX files.

**Feature safety:** Same CSS, same specificity, same scoping. No Emotion runtime is involved (respects finding 14). Dynamic imports ensure no CSS leak between routes.

---

## 10. Reduce `WorkflowLibraryPanel.tsx` further — DONE

After extracting CSS (item 9), the component is ~430 lines. Two trivial wrappers can be inlined:

### 10a. Inline `handleOpenProject` — DONE

`handleOpenProject` on line 550 is `(absolutePath) => onOpenProject(absolutePath)`. Replace the `onClick` on line 494 with `onClick={() => onOpenProject(project.absolutePath)}`.

### 10b. Inline `handleSwitchProject` — DONE

`handleSwitchProject` on line 554 is `(absolutePath) => onOpenProject(absolutePath, { replaceCurrent: true })`. Replace the `onDoubleClick` on line 495 with `onDoubleClick={() => onOpenProject(project.absolutePath, { replaceCurrent: true })}`.

### 10c. Simplify body rendering conditions — DONE

Lines 676-684 repeat `!loading && !error && ...` multiple times. Extract the body content into a local variable computed before the JSX return:

```ts
let bodyContent: JSX.Element | null = null;
if (loading) {
  bodyContent = <div className="state">Loading folders...</div>;
} else if (error) {
  bodyContent = <div className="state">{error}</div>;
} else if (folderIds.length === 0 && rootProjects.length === 0) {
  bodyContent = <div className="state">No workflow projects yet. Use + New folder to create the first folder.</div>;
} else {
  bodyContent = <>
    {rootProjects.length > 0 ? <div className="projects">{rootProjects.map(renderProjectRow)}</div> : null}
    {folders.map(renderFolder)}
  </>;
}
```

Then use `{bodyContent}` in the JSX. This replaces 4 separate `!loading && !error &&` conditionals with one clear `if/else if` block.

**Files changed:** `wrapper/web/dashboard/WorkflowLibraryPanel.tsx`

**Estimated reduction:** ~15 lines.

**Feature safety:** Same render output for every state combination.

---

## 11. Simplify the `handleDatasetsMessage` function — DONE

### Problem

`wrapper/web/overrides/hooks/useRemoteDebugger.ts` lines 212-327 contain 9 nearly identical `match` branches from `ts-pattern`. Each branch awaits a `datasetProvider` method, then sends a response through the same `socket.send(JSON.stringify({ type: 'datasets:response', data: { requestId, payload } }))` call. Only the method name and argument destructuring vary.

### Change

Replace the `match` chain with a dispatch map. Remove the `ts-pattern` import from this file (the `match` import on line 11).

```ts
const datasetHandlers: Record<string, (payload: any) => Promise<unknown>> = {
  'datasets:get-metadata': (p) => datasetProvider.getDatasetMetadata(p.id),
  'datasets:get-for-project': (p) => datasetProvider.getDatasetsForProject(p.projectId),
  'datasets:get-data': (p) => datasetProvider.getDatasetData(p.id),
  'datasets:put-data': (p) => datasetProvider.putDatasetData(p.id, p.data),
  'datasets:put-row': (p) => datasetProvider.putDatasetRow(p.id, p.row),
  'datasets:put-metadata': (p) => datasetProvider.putDatasetMetadata(p.metadata),
  'datasets:clear-data': (p) => datasetProvider.clearDatasetData(p.id),
  'datasets:delete': (p) => datasetProvider.deleteDataset(p.id),
  'datasets:knn': (p) => datasetProvider.knnDatasetRows(p.datasetId, p.k, p.vector),
};

async function handleDatasetsMessage(type: string, data: any, socket: WebSocket) {
  const handler = datasetHandlers[type];
  if (!handler) {
    console.error(`Unknown datasets message type: ${type}`);
    return;
  }
  const { requestId, payload } = data;
  const result = await handler(payload);
  socket.send(JSON.stringify({
    type: 'datasets:response',
    data: { requestId, payload: result },
  }));
}
```

Note: `ts-pattern` is still used by upstream `rivet/` code, so the package stays in `node_modules`. Only the import in this specific file is removed.

**Files changed:** `wrapper/web/overrides/hooks/useRemoteDebugger.ts` — replace lines 11 (import), 212-327 (function body).

**Estimated reduction:** ~90 lines.

**Feature safety:** Same dataset methods called with same arguments, same response JSON format, same error logging for unknown types.

---

## 12. Improve `EditorMessageBridge.tsx` Ctrl+S platform detection — DONE

### Problem

`wrapper/web/dashboard/EditorMessageBridge.tsx` line 15 uses `navigator.userAgent.includes('Win64')` to detect Windows and skip the iframe-side Ctrl+S handler (because on Windows, the parent document's capture handler already catches keystrokes from same-origin iframes). This platform sniff is fragile — it relies on exact UA string content that could change.

### Background

Both the parent (`DashboardPage.tsx`) and the iframe (`EditorMessageBridge.tsx`) need independent Ctrl+S listeners because on non-Windows platforms, keydown events inside a same-origin iframe do NOT bubble to the parent document. On Windows they do, which causes double-save without the platform check.

### Change

Replace the UA string check on line 15:

```ts
// Before:
const isWindowsPlatform = typeof navigator !== 'undefined' && navigator.userAgent.includes('Win64');

// After:
const isWindowsPlatform = typeof navigator !== 'undefined' && /Win/.test(navigator.platform ?? '');
```

`navigator.platform` is more stable than parsing `navigator.userAgent` — it returns short strings like `'Win32'` on all Windows versions (including 64-bit).

**Files changed:** `wrapper/web/dashboard/EditorMessageBridge.tsx` — line 15 only.

**Feature safety:** Same conditional logic, more robust detection. The save behavior is unchanged: on Windows, the parent handles Ctrl+S; on other platforms, the iframe handles it. The `save-project` message handler (line 56) still works as a fallback on all platforms.

---

## 13. Fix the "yed" typos in `useRemoteExecutor.ts` — DONE

In `wrapper/web/overrides/hooks/useRemoteExecutor.ts`, lines 392, 394, and 396 have `throw new Error('Not implemented yed')`. Change `'yed'` to `'yet'` in all three.

**Files changed:** `wrapper/web/overrides/hooks/useRemoteExecutor.ts` — 3 string literals.

---

## 14. Clarify Vite config structure with comments — DONE

### Problem

`wrapper/web/vite.config.ts` is 260 lines with four different alias resolution strategies that interact with each other. The ordering matters (finding 4 in `findings-and-problems.md`), but there's minimal documentation of *why* each section exists.

### Change

Add section comments explaining:
- Why Tauri shims must come first (most specific, prevents upstream Tauri imports from resolving)
- Why override aliases use `^\.\.?\/` regex patterns (finding 4 — catches relative imports only, avoids breaking bare imports)
- Why wrapper dependency aliases exist (upstream `rivet/` would resolve to its own node_modules otherwise, causing version mismatches)
- Why `@google/genai` and `nanoid` get explicit browser subpath aliases (upstream entry points pull Node-only code)

Do NOT restructure the alias array — the current order is correct and ordering matters.

**Files changed:** `wrapper/web/vite.config.ts` — add comments at lines ~157, ~173, ~189, ~110.

**Feature safety:** Comments only. No code changes.

---

## 15. Reduce `useRemoteExecutor.ts` duplication — DONE

### Problem

In `wrapper/web/overrides/hooks/useRemoteExecutor.ts`, `tryRunGraph` (lines 182-205) and the `runGraph` callback inside `tryRunTests` (lines 272-290) both contain the same "check if upload is allowed, then send `set-dynamic-data` with project + settings, then send `set-static-data` for each data entry" block.

The `contextValues` reduction (entries of projectContext reduced into a Record) also appears in both places (lines 207-213 and 306-312).

### Change

Extract two local helper functions within the `useRemoteExecutor` hook body:

```ts
async function uploadProjectIfAllowed() {
  const canUpload =
    remoteDebugger.remoteDebuggerState.isInternalExecutor ||
    remoteDebugger.remoteDebuggerState.remoteUploadAllowed;

  if (!canUpload) return;

  remoteDebugger.send('set-dynamic-data', {
    project: {
      ...project,
      graphs: { ...project.graphs, [graph.metadata!.id!]: graph },
    },
    settings: await fillMissingSettingsFromEnvironmentVariables(
      savedSettings,
      globalRivetNodeRegistry.getPlugins(),
    ),
  });

  for (const [id, dataValue] of entries(projectData)) {
    remoteDebugger.sendRaw(`set-static-data:${id}:${dataValue}`);
  }
}

function buildContextValues(): Record<string, DataValue> {
  return entries(projectContext).reduce(
    (acc, [id, value]) => ({ ...acc, [id]: value.value }),
    {} as Record<string, DataValue>,
  );
}
```

Call `uploadProjectIfAllowed()` and `buildContextValues()` from both `tryRunGraph` and the test `runGraph` callback.

**Files changed:** `wrapper/web/overrides/hooks/useRemoteExecutor.ts`

**Estimated reduction:** ~25 lines.

**Feature safety:** Same data sent to the same executor endpoints. The helpers are local functions with closure access to the same hook state.

---

## 16. Simplify `HostedIOProvider.loadProjectData` flow — DONE

### Problem

In `wrapper/web/io/HostedIOProvider.ts`, the `loadProjectData` method (lines 157-191) has a convoluted flow: it tries listing projects, shows a numbered prompt, parses the response as either a number or a path, and then falls back to a second `prompt()` if the listing API fails or returns empty.

### Change

Combine the two prompts into one. When projects exist, show the numbered list with a note that custom paths are accepted. When no projects exist, show a simpler prompt asking for a path directly. The key constraint is that the **fallback prompt for manual path entry must be preserved** — without it, users on fresh installs with no existing projects would have no way to load a project.

```ts
async loadProjectData(
  callback: (data: { project: Project; testData: TrivetData; path: string }) => void,
): Promise<void> {
  let promptMessage = 'Enter server path to .rivet-project file:';

  try {
    const files = await apiListProjects();
    if (files.length > 0) {
      promptMessage = `Available projects on server:\n${files.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nEnter number or full path:`;
    }
  } catch {
    // Listing failed — fall through to manual path prompt
  }

  const selection = prompt(promptMessage);
  if (!selection) return;

  let filePath: string;
  const num = parseInt(selection, 10);
  // Only treat as index if listing succeeded and number is in range
  // (apiListProjects result may not exist if the try/catch fell through)
  if (!isNaN(num) && num >= 1) {
    try {
      const files = await apiListProjects();
      filePath = (num <= files.length) ? files[num - 1]! : selection;
    } catch {
      filePath = selection;
    }
  } else {
    filePath = selection;
  }

  const projectData = await this.loadProjectDataNoPrompt(filePath);
  callback({ ...projectData, path: filePath });
}
```

Actually, this adds complexity instead of removing it. A simpler approach:

Keep the current two-prompt structure but remove the `try/catch` nesting that makes it hard to follow. The current code already works correctly — the real improvement is readability, not fewer prompts. Add a comment explaining the fallback flow.

**Revised change:** Add clarifying comments to the existing `loadProjectData` method. Do not change the flow.

**Files changed:** `wrapper/web/io/HostedIOProvider.ts` — add comments to lines 157-191.

**Feature safety:** No behavioral change.

---

## 17. Strengthen `validatePath` for Windows (dev:local mode only) — DONE

### Problem

`wrapper/api/src/security.ts` uses `resolved.startsWith(root + path.sep)` to validate paths. On case-insensitive filesystems (Windows), this check could be bypassed with case variations.

### Scope

This only matters when running the API directly on Windows via `dev:local` mode. In production, the API runs inside a Docker container (Linux), where the filesystem is case-sensitive and the current check is correct.

### Change

In `wrapper/api/src/security.ts`, update the `validatePath` function's `startsWith` check:

```ts
// Before:
if (resolved !== root && !resolved.startsWith(root + path.sep)) {

// After:
const isMatch = process.platform === 'win32'
  ? (a: string, b: string) => a.toLowerCase().startsWith(b.toLowerCase())
  : (a: string, b: string) => a.startsWith(b);

if (resolved !== root && !isMatch(resolved, root + path.sep)) {
```

Apply the same case-insensitive comparison to `resolved !== root` on Windows.

**Files changed:** `wrapper/api/src/security.ts` — update `validatePath` function.

**Feature safety:** Only strengthens the existing check. All currently-valid paths remain valid. On Linux (production), behavior is identical.

---

## Summary of estimated impact

| Category | Lines removed/simplified | Files affected |
|----------|------------------------|----------------|
| Dead code removal | ~70 | 2 files deleted, 2 files edited |
| Shared API helpers | ~50 | 2 frontend files + 1 new shared file |
| Script dedup | ~40 | 3 script files + 1 new |
| API exec dedup | ~30 | 2 API files + 1 new util |
| Route merging | ~15 | 1 file deleted, 2 files edited |
| API error consolidation | ~40 | 8 API files + 1 new util |
| CSS extraction | ~340 moved to .css | 2 TSX files + 2 new CSS files |
| Dataset handler simplification | ~90 | 1 hook file |
| `useOpenWorkflowProject` cleanup | ~17 | 1 file |
| Executor dedup | ~25 | 1 file |
| WorkflowLibraryPanel cleanup | ~15 | 1 file |
| Ctrl+S fix | ~1 | 1 file |
| Typo fix | 3 | 1 file |
| Comments / docs | +20 | 3 files |
| **Total** | **~395 lines net reduction** + 340 lines moved to CSS | ~25 files touched |

---

## Constraints respected

- **Vendor boundary** (finding 13): No changes inside `rivet/`. All refactoring is in `wrapper/`, `ops/`, and `scripts/`.
- **Vite alias ordering** (findings 4, 14): Alias array is not restructured. Comments are added but order preserved.
- **Override file path depth** (finding 5): No override files are moved to different directory depths.
- **Executor bundle patching** (finding 12): `ops/bundle-executor.cjs` is not touched.
- **Ctrl+S behavior** (finding 17, description.md save behavior): Save still targets the active editor tab's file-backed path.
- **Workflow pane quiet success** (finding 16): Toast behavior unchanged.
- **Dashboard component aliases** (finding 14): No new component-level Vite aliases are introduced.
- **Workflow host path resolution** (finding 15): `dev-docker.mjs` still resolves paths from repo root; the shared `parseEnvFile` is called before resolution.
- **Hosted executor selection** (finding 2): `useGraphExecutor` selection logic is not changed.
- **WebSocket singleton** (finding 11): `useRemoteDebugger` architecture (module-level singleton + React hook wrapper) is preserved. Only the dataset handler internals change.
- **Active project visibility** (description.md): Auto-expand and scroll-into-view logic in `WorkflowLibraryPanel` is not changed.
- **Drag-and-drop with save-path preservation** (description.md): Move logic in both API and frontend is not changed.
- **useSyncCurrentStateIntoOpenedProjects timing** (finding 17): Effect dependency arrays are NOT changed (item 8 was downgraded to comments-only).
- **loadProjectData fallback** (HostedIOProvider): The manual path entry prompt is preserved for fresh installs (item 16 was downgraded to comments-only).

---

## Recommended execution order

1. **Items 1, 13** (dead code + typos — zero-risk warmup)
2. **Items 3, 4, 5, 6** (deduplication — each is independent)
3. **Items 7** (API error handling — requires asyncHandler wrapper, test all routes)
4. **Item 9** (CSS extraction — large diff but zero logic change)
5. **Items 2, 10, 11, 15** (logic simplifications — each independently testable)
6. **Items 12, 17** (behavioral refinements — test on both Windows and Linux)
7. **Items 8, 14, 16** (comments — do last, after all structural changes are settled)
