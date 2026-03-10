# Refactor Plan

## Guiding Principles

- All existing functionality stays intact (see `description.md` regression checklist)
- Nothing inside `rivet/` is modified — it remains vendored and replaceable
- Every change must make the codebase smaller, simpler, or more secure — never more abstract
- Prepare for future authentication without implementing it yet
- Changes are ordered by impact and grouped so each group can be landed independently

---

## Phase 1: API Security & Structure

The API currently has zero authentication on internal endpoints. Anyone who can reach port 3100 (or 8080 via nginx) can read/write files, run shell commands, and manage workflows. This is the most urgent gap, and the structure of the fix matters for the upcoming auth work.

### 1.1 DONE Add an Express middleware skeleton for auth

Create `wrapper/api/src/middleware/auth.ts` exporting a no-op middleware that sits on all `/api/*` routes. Right now it passes through unconditionally. When auth is implemented later, this single file becomes the enforcement point.

```
// Phase 1: pass-through
export const requireAuth: RequestHandler = (_req, _res, next) => next();
```

Mount it in `server.ts` before all `/api/*` route mounts:

```ts
app.use('/api', requireAuth);
```

Published/latest workflow execution routes (`PUBLISHED_WORKFLOWS_BASE_PATH`, `LATEST_WORKFLOWS_BASE_PATH`) stay outside this middleware — they already have their own Bearer-token check and will later get their own auth treatment.

This means future auth is a single-file change.

### 1.2 DONE Replace custom `.env` parser with `dotenv`

`loadRootEnv.ts` is 72 lines of hand-rolled `.env` parsing that searches 7 candidate paths. The search is doubly redundant:

- In Docker, env vars arrive via `docker-compose.yml` `environment`/`env_file` before the Node process starts.
- In local dev via `scripts/dev.mjs`, the script parses `.env.dev` itself and injects the vars into the child process environment. `loadRootEnv.ts` then searches for a different filename (`.env`, not `.env.dev`) and only sets vars that aren't already set — so it either finds nothing or finds a stale file.

Replace with:

```ts
import 'dotenv/config';  // at the top of server.ts only
```

`dotenv/config` looks for `.env` in `process.cwd()` and silently does nothing if the file is absent — correct behavior for both Docker (no `.env` needed) and local dev (env already injected by the launcher script).

Delete `loadRootEnv.ts`. Remove the `import './loadRootEnv.js'` side-effect imports from `security.ts` and `workflowEndpointPaths.ts` — they only exist to ensure the env is loaded before reading `process.env`, which is now guaranteed by the single import at the top of `server.ts`.

Add `dotenv` to `wrapper/api/package.json` dependencies.

Net: **−70 lines**, eliminates a hand-rolled parser.

### 1.3 DONE Centralize path/config constants

Scattered magic strings (`.wrapper-settings.json`, `.rivet-data`, `.published`, etc.) are repeated across `fs-helpers.ts`, `publication.ts`, `tree.ts`, and `native.ts`.

Move all of these into the existing `fs-helpers.ts` (they're mostly already there). The remaining duplications are:
- `getWorkflowDatasetPath` uses a hardcoded `.rivet-data` string instead of reusing a constant — make it use the same constant as `getProjectSidecarPaths`
- `publication.ts` re-imports several helpers; nothing to change there, just verify no duplication

This is a minor cleanup (~5 lines changed).

### 1.4 DONE Stop leaking stack traces from workflow execution errors

`executeWorkflowEndpoint()` has its own try/catch that returns `{ error: { name, message, stack } }` on failure. The `stack` property leaks server internals to external API consumers.

**Do not remove the try/catch.** The workflow execution endpoints are external-facing APIs and their error response format (`{ error: { name, message } }`) is a contract. Removing the try/catch would change the response shape to `{ error: "message" }` (the Express error middleware format), which is a silent breaking change for consumers.

Instead, keep the try/catch but strip the `stack` property:

```ts
res.status(500).json({
  error: error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) },
});
```

Log the full error (with stack) server-side for debugging.

Net: **−3 lines**, same response shape, no stack leak.

### 1.5 DONE Stop leaking resolved paths and stack traces in error responses

`validatePath()` in `security.ts` currently throws:

```
Path not allowed: /etc/passwd (resolved: /etc/passwd)
```

This leaks the server's absolute path structure. Change to:

```
Path not allowed
```

The resolved path is still useful for server-side debugging, so log it with `console.error` (or the future structured logger — see Phase 3) before throwing.

Similarly, the error middleware in `server.ts` should not send `err.message` verbatim for 500 errors. For non-`HttpError` errors, return a generic `"Internal server error"` and log the real error.

---

## Phase 2: Reduce Overengineering

### 2.1 DONE Simplify the runtime library release system

The current numbered release directory system (`0001`, `0002`, …) with a pointer file, startup reconciliation, and old-release pruning is more infrastructure than needed. Simplify to two directories:

```
<root>/
  manifest.json
  current/        ← the active release (package.json + node_modules)
  staging/        ← build area, promoted to current/ via rename
```

Changes:
- `manifest.ts`: Remove `nextReleaseId()`, `activeReleaseNodeModulesPath()`, `readActiveRelease()`, `writeActiveRelease()`, `releasesDir()`. Replace with `currentDir()` and `stagingDir()` returning paths to `current/` and `staging/`.
- `job-runner.ts` `buildAndPromote()`: Instead of promoting staging → numbered release and writing a pointer file, do:
  1. Rename existing `current/` (if any) to `current.old/`
  2. Rename `staging/` → `current/`
  3. Remove `current.old/` in the background
- `startup.ts`: Simplify to: does `current/node_modules` exist? If yes, sync manifest. If no, clear manifest and log. Remove `cleanupOldReleases()` entirely.
- `managed-code-runner.ts`: Read from `<root>/current/node_modules` directly instead of reading a pointer file then resolving a numbered path.
- `bundle-executor.cjs`: Same simplification for the executor-side dynamic require patch. The current patch reads the `active-release` pointer file, then resolves `releases/<pointer>/node_modules`. Replace with a direct check for `current/node_modules`.

Delete the `active-release` pointer-file concept entirely.

**Race condition note:** Between step 1 (rename `current/` away) and step 2 (rename `staging/` in), a concurrent code-node execution that has already resolved the `current/` path but not yet called `require()` could fail. In the old system, numbered releases persist so this window doesn't exist. However: library installs are rare (manually triggered by a user in the UI), the window between the two renames is microseconds, and the consequence is a single failed request that succeeds on retry. This trade-off is acceptable given the significant complexity reduction.

Net: **−80 to −100 lines** across 5 files, simpler mental model.

### 2.2 DONE Remove redundant overrides

- `wrapper/web/overrides/utils/globals/datasetProvider.ts` — This override is a pure re-export of the upstream `BrowserDatasetProvider`. The upstream file (`rivet/packages/app/src/utils/globals/datasetProvider.ts`) is functionally identical: same import, same singleton instantiation, same export. The `BrowserDatasetProvider` class uses IndexedDB and is entirely browser-safe — no Tauri dependency. Remove the override file and remove its regex alias from `vite.config.ts` (line 184). The upstream import will resolve naturally.

Net: **−1 file, −5 lines**, one fewer regex alias to maintain.

### 2.3 DONE Clean up the `tauri-apps-api-fs.ts` shim

`renameFile()` and `copyFile()` are exported as no-op stubs that log warnings (12 lines total). Verified: no upstream code in `rivet/` imports either name — zero grep matches. Safe to remove both functions entirely.

Net: **−12 lines**.

### 2.4 DONE Remove `ensurePathDoesNotExist` from `fs-helpers.ts`

It's only used in `tree.ts` for move-collision checks. Its implementation is a try/catch around `fs.access` that throws on success — an inverted `pathExists`. Replace the call sites with:

```ts
if (await pathExists(targetPath)) throw conflict(`Already exists: ${name}`);
```

This is clearer and eliminates a helper whose name is easily confused with destructive operations.

Net: **−10 lines**.

---

## Phase 3: Code Quality

### 3.1 DONE Add `zod` for request body validation

Manual `if (!body.name)` checks across `workflows/index.ts`, `native.ts`, `shell.ts`, `plugins.ts`, and `runtime-libraries.ts` are inconsistent and easy to miss. Add `zod` as a dependency and create a thin middleware helper:

```ts
// wrapper/api/src/middleware/validate.ts
import { z, ZodSchema } from 'zod';
import { badRequest } from '../utils/httpError.js';

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) throw badRequest(result.error.issues[0].message);
    req.body = result.data;
    next();
  };
}
```

Then define schemas next to each route file. Example for `POST /api/shell/exec`:

```ts
const execSchema = z.object({
  program: z.string().min(1),
  args: z.array(z.string()).default([]),
  options: z.object({ cwd: z.string().optional() }).default({}),
});

shellRouter.post('/exec', validateBody(execSchema), asyncHandler(async (req, res) => { ... }));
```

Apply incrementally — start with `shell.ts` and `runtime-libraries.ts` (highest-risk), then the rest.

Net: Adds ~30 lines of shared infrastructure, saves scattered manual checks, and provides automatic type narrowing. Overall line count roughly neutral, but reliability and maintainability improve significantly.

### 3.2 DONE Consolidate `exec.ts` and `exec-streaming.ts`

Both files wrap `child_process.spawn` with slightly different interfaces. Merge into a single `wrapper/api/src/utils/exec.ts`:

```ts
// Non-streaming: returns Promise<ExecResult> (existing behavior)
export function exec(program, args, opts): Promise<ExecResult> { ... }

// Streaming: returns EventEmitter (existing behavior)
export function execStreaming(program, args, opts): StreamingExec { ... }
```

Delete `runtime-libraries/exec-streaming.ts`, update imports in `job-runner.ts`.

Net: **−1 file, −20 lines** (shared spawn option handling).

### 3.3 DONE Tighten the plugin install flow

`plugins.ts` is the largest single route file (~217 lines) and does too much in one handler. Split into two internal helpers:

- `downloadAndExtractPlugin(pkg, tag)` — fetches tarball, extracts, installs deps, returns log
- `checkPluginForUpdate(pkg, tag)` — the update-detection logic

The route handler becomes a thin orchestrator. This doesn't change behavior but makes the 190-line handler readable and testable.

### 3.4 DONE Type the `ws` module properly

`wrapper/api/src/ws.d.ts` is a single-line stub: `declare module 'ws';`. This gives `ws` an implicit `any` type, which means `WebSocketServer` usage in `latestWorkflowRemoteDebugger.ts` has no type checking. Add `@types/ws` to `devDependencies` and delete the stub.

Net: **−1 file**, plus actual type safety for WebSocket code.

---

## Phase 4: Frontend Cleanup

### 4.1 DONE Simplify Vite config

`vite.config.ts` at 270 lines is the most complex single file in the wrapper. Split the alias definitions into a separate data file.

Create `wrapper/web/vite-aliases.ts` that exports factory functions (not raw arrays), since the alias entries depend on resolved directory paths (`shimDir`, `overrideDir`, `__dirname`) that are derived in the config:

```ts
import { resolve } from 'node:path';

export function createTauriShimAliases(shimDir: string) { return [ ... ]; }       // 11 entries
export function createModuleOverrideAliases(overrideDir: string) { return [ ... ]; } // 14 entries
export function createBrowserSubpathAliases(webDir: string) { return [ ... ]; }      // 6 entries
```

The main `vite.config.ts` computes the directory paths and calls the factories:

```ts
import { createTauriShimAliases, createModuleOverrideAliases, createBrowserSubpathAliases } from './vite-aliases';

// in resolve.alias:
...createTauriShimAliases(shimDir),
...createModuleOverrideAliases(overrideDir),
...createBrowserSubpathAliases(__dirname),
```

Net: Config drops to ~100 lines; new file is ~120 lines of pure alias data with clear structure. Total lines roughly neutral, but the config is navigable and the alias lists are independently reviewable.

### 4.2 DONE Deduplicate `normalizeBasePath`

The same `normalizeBasePath` function exists in both `wrapper/shared/hosted-env.ts` (frontend, bundled by Vite) and `wrapper/api/src/workflowEndpointPaths.ts` (backend, Node ESM). Extract to `wrapper/shared/normalize-base-path.ts` and import from both.

This cross-environment sharing pattern already works in the codebase: `wrapper/api/src/routes/workflows/types.ts` imports from `../../../../shared/workflow-types.js`. The function is pure string manipulation with no Node or browser APIs, so it runs in both environments. The backend imports with `.js` extension (Node ESM requirement); the frontend imports without extension (Vite resolves it).

Net: **−10 lines**.

### 4.3 DONE Clean up the shared API helper

`wrapper/shared/api.ts` duplicates fetch+error patterns across 4 functions. Extract a shared internal helper:

```ts
async function apiPost<T>(endpoint: string, body: object): Promise<T> {
  const resp = await fetch(`${API}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`API error: ${resp.statusText}`);
  return resp.json();
}
```

Then:

```ts
export const apiReadText = (path: string) => apiPost<{ contents: string }>('/native/read-text', { path }).then(d => d.contents);
export const apiWriteText = (path: string, contents: string) => apiPost('/native/write-text', { path, contents });
// ...
```

Net: **−15 lines**.

---

## Phase 5: Auth-Readiness Structural Prep

These changes don't implement auth but make it straightforward to add later.

### 5.1 DONE Structure the middleware directory

Create `wrapper/api/src/middleware/` with:
- `auth.ts` — the no-op middleware from Phase 1.1
- `validate.ts` — the zod helper from Phase 3.1

All future middleware (rate limiting, CORS config, session handling) goes here.

### 5.2 DONE Prepare session-aware response headers

Add a placeholder CORS configuration in `server.ts` that:
- Uses `cors({ origin: true, credentials: true })` instead of bare `cors()`
- This allows cookies/credentials when auth is added later
- No behavioral change now since there's no auth

### 5.3 DONE Document the auth integration points

Add a section to this refactor.md (or a separate `AUTH-PLAN.md`) listing the exact touch points for the planned auth system:

**Auth will need to touch:**
1. `middleware/auth.ts` — session/token validation
2. `server.ts` — session middleware setup (cookie-based sessions or JWT)
3. `.env` / `.env.dev` — admin credentials, session secret
4. New routes: `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/invite`, `POST /api/auth/register`
5. A user store — flat JSON file on disk (no database), encrypted passwords
6. nginx config — ensure session cookies are forwarded (`proxy_set_header Cookie`)
7. Frontend — login page component, auth state management, protected route wrapper

**Auth will NOT need to touch:**
- Workflow execution endpoints (they have their own Bearer-token system)
- The Vite config or any shims/overrides
- The runtime library manager
- The executor service

---

## Phase 6: Docker & Ops Cleanup

### 6.1 DONE Forward debugger env vars in production compose

The production `ops/docker-compose.yml` doesn't forward `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER` or `RIVET_LATEST_REMOTE_DEBUGGER_TOKEN` to the API container. Add them to the `api.environment` block with empty defaults so they can be set when needed:

```yaml
- RIVET_ENABLE_LATEST_REMOTE_DEBUGGER=${RIVET_ENABLE_LATEST_REMOTE_DEBUGGER:-false}
- RIVET_LATEST_REMOTE_DEBUGGER_TOKEN=${RIVET_LATEST_REMOTE_DEBUGGER_TOKEN:-}
```

### 6.2 DONE Add `RIVET_ENDPOINT_API_KEY` to production compose

Currently missing from `ops/docker-compose.yml` API environment block. Add:

```yaml
- RIVET_ENDPOINT_API_KEY=${RIVET_ENDPOINT_API_KEY:-}
```

---

## Boundary: `rivet/` is untouched

No phase in this plan modifies any file inside `rivet/`. The only interaction with the vendored upstream is:

- `ops/bundle-executor.cjs` patches upstream source **at Docker build time** (already the case, this plan only changes what the patch resolves)
- `vite.config.ts` aliases intercept upstream imports at build time (already the case, this plan removes one alias)

The upstream directory remains vendor-style and replaceable.

---

## Summary: Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| Files removed | — | ~4 (`loadRootEnv.ts`, `datasetProvider.ts`, `exec-streaming.ts`, `ws.d.ts`) |
| Lines removed (net) | — | ~200 |
| Hand-rolled parsers | 1 (env) | 0 |
| Request validation | manual | schema-based (zod) |
| Auth middleware | none | skeleton ready |
| Error leak risk | high (paths, stacks) | low |
| Runtime lib complexity | N numbered dirs + pointer + pruning | 2 dirs (current + staging) |
| Vite alias count | 15 regex + 11 exact | 14 regex + 11 exact |

All existing functionality preserved. No UI changes. No database additions. No changes to `rivet/`. Auth-ready without implementing auth.
