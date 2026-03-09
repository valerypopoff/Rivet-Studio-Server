# Runtime Library Manager Plan

## Feature overview

The self-hosted Rivet wrapper currently allows Node Code nodes to use external npm libraries such as `sharp`, but only after those libraries are wired into the runtime environment by repository-level development changes. That is workable for one-off engineering fixes, but it is not a usable product feature for normal workflow authors.

What we need instead is a first-class runtime library manager inside the hosted wrapper UI.

This feature should let a user:

- see which additional runtime libraries are currently installed and available to workflow Code nodes
- add a library by package name and version
- remove a previously installed library
- run the installation or removal from the UI
- see live console output while the operation is running
- get a clear success or failure verdict when the operation completes

The feature is needed because there are two separate runtime contexts in this product:

- the editor-side Node execution environment used when a workflow is run from the Rivet editor
- the API-side execution environment used when a published workflow endpoint is called

If a library exists in only one of those runtimes, workflows become inconsistent. A Code node may work in the editor but fail after publication, or vice versa. That is exactly the kind of mismatch this feature is meant to eliminate.

The goal is to make external runtime libraries a managed product capability instead of a manual devops task.

## Why this feature is needed

Right now, adding a runtime library requires code or infrastructure changes by a developer. That creates several problems:

- it is not discoverable to normal users
- it is easy for editor execution and endpoint execution to drift apart
- it often requires rebuilding or restarting services
- it creates risk when changing live runtime dependencies
- it makes troubleshooting hard because the user cannot see installation progress or logs

A dedicated runtime library manager solves those problems by providing:

- a single source of truth for which runtime libraries are installed
- a safe workflow for adding and removing packages
- shared availability for both editor runs and published endpoints
- persistence across restarts and rebuilds
- live feedback in the UI during installation
- strong isolation so a failed install does not break the running app

## Product requirements

### Functional requirements

- the user must be able to open a dedicated popup from the left pane
- the popup must list installed runtime libraries
- the user must be able to add a package name and version string
- the user must be able to remove an installed package
- the user must explicitly start installation or removal via UI buttons
- the UI must show live console output for the running operation
- the UI must show a clear final status when the operation succeeds or fails
- newly installed libraries must work in both:
  - editor-side Node workflow runs
  - published workflow endpoints
- the user must not need to restart Docker or restart the app to use newly installed libraries
- installed libraries must persist across container restarts and rebuilds
- if persistent files are missing or out of sync after startup, the system should be able to restore the runtime library environment automatically

### Safety requirements

- installing or removing libraries must never modify the active runtime in place
- a failed install must not break the already running application
- published endpoints must continue working even if an installation attempt fails
- the worst-case result of a failed install should be that the requested change is rejected while the previous good runtime remains active
- only validated runtime sets should ever become active

### UX requirements

- the popup trigger should be placed in the bottom-left corner of the left pane when the pane is open
- the popup should show current state clearly:
  - installed libraries
  - pending operation
  - streaming logs
  - final result
- the UI should disable conflicting actions while a mutation job is running
- errors should be actionable and visible without requiring the user to inspect server logs manually
- log visibility and final status should live primarily inside the popup instead of generating a stream of global success toasts

### Repository constraints

- the implementation must not modify contents under `rivet/`
- hosted-specific behavior must remain wrapper-owned
- runtime library state must live in wrapper-owned code or persistent app-data storage
- do not introduce broad Vite aliases or component-level overrides for this feature; the UI should be added locally to the dashboard code so the shared editor bundle and `/?editor` route are not destabilized
- do not rely on container restarts, web rebuilds, or executor reconnects as part of normal install/remove flow; Node mode depends on a healthy remote debugger websocket and the feature must not make the Run button disappear during routine library operations
- keep success feedback quiet outside the popup itself; workflow-pane work should not regress into noisy global success toasts when visible UI state and the log panel are enough
- when tracking jobs, installed libraries, or selected entries in React state, use stable identifiers such as job ids, package names, and release ids rather than recreated objects so the UI does not fall into refresh loops similar to the earlier workflow-tree issue
- any wrapper-owned executor patching must fail loudly if upstream source moves enough that the patch no longer applies; do not use silent string replacement for critical runtime behavior

## Non-goals

- supporting arbitrary system package installation outside npm packages
- silently mutating the runtime when the user did not request a change
- requiring container restarts for normal add/remove operations
- allowing partial activation of a broken install
- storing runtime library state in the `rivet/` vendor tree

## High-level design

### Core idea

Runtime libraries should be managed as a wrapper-owned shared runtime resource. Both execution paths must resolve packages from the same managed library store:

- the editor executor container
- the API container that serves published workflow endpoints

That shared library store must be:

- persistent
- versioned
- safely updatable
- hot-switchable without breaking in-flight work

### Shared managed runtime library store

A persistent app-data location should be introduced for runtime libraries, separate from source-controlled files. Example structure:

```text
<data-root>/runtime-libraries/
  manifest.json
  releases/
    0001/
      package.json
      package-lock.json
      node_modules/
    0002/
      package.json
      package-lock.json
      node_modules/
  staging/
```

The manifest should track at least:

- the desired set of installed packages and versions
- the active release id
- the last successful release id
- install metadata such as timestamps and possibly the last error summary

Both long-lived runtimes should resolve packages from the active managed release rather than from ad hoc image-baked dependencies.

The shared runtime-library store must have an explicit wrapper-owned root path that is mounted into both the API and executor services in a deliberate, identical way. The current stack already uses different app-data conventions for different services, so this feature must not assume that existing plugin or home-directory locations automatically line up. Introduce a dedicated runtime-libraries root configuration rather than inferring one from `HOME`, plugin paths, or relative Docker working directories.

## Why a versioned release model is required

A simple shared `node_modules` directory is not safe enough.

If the live directory is modified in place while the app is running, several bad outcomes become possible:

- a package install may fail halfway and leave the directory inconsistent
- one runtime may observe partially updated files while another is executing
- rollback becomes difficult
- removing a package can break future requests immediately without validation

A versioned release model avoids those problems.

The safe approach is:

- build a new candidate runtime in a staging directory
- install requested packages there
- validate the candidate
- atomically promote it to a new active release only if validation succeeds
- leave the currently active release untouched if anything fails
- never run package-manager writes directly against the currently active release, source-controlled files, or image-baked runtime directories

This design ensures that failed operations do not break the live application.

## Current architecture analysis (verified against codebase)

Understanding the two execution paths precisely is critical. The plan must be grounded in how code actually runs today, not in assumptions.

### Editor execution path (executor container)

Editor-side Node workflow runs go through the **executor container** via WebSocket:

1. The browser connects to the executor at `ws://localhost/ws/executor` via nginx proxy
2. The executor is a **bundled CJS file** (`executor-bundle.cjs`) built by `ops/bundle-executor.cjs` at Docker image build time
3. Inside the executor, `dynamicGraphRun()` in `rivet/packages/app-executor/bin/executor.mts` calls `createProcessor()` from `rivet/packages/node/src/api.ts`
4. `createProcessor()` instantiates a default `NodeCodeRunner` (line 76 of `api.ts`: `codeRunner: options.codeRunner ?? new NodeCodeRunner()`)
5. When a Code node has `allowRequire: true`, `NodeCodeRunner.runCode()` calls `createRequire(import.meta.url)` to create a require function
6. **The bundle-executor.cjs patches this** at build time (line 181-186), replacing the `createRequire` call with `createRequire(process.cwd() + '/executor-bundle.cjs')`, which resolves to `/app/executor-bundle.cjs` in the Docker container
7. Combined with `ENV NODE_PATH=/app/node_modules` in Dockerfile.executor (line 32), this allows code nodes to `require('sharp')` from `/app/node_modules/`

Key facts:
- The executor is built as a **static CJS bundle** — runtime behavior is determined by build-time patches
- `createRequire()` is called **fresh on every `runCode()` invocation**, not cached — this is important for hot-switching
- The executor process does NOT call `runGraph()` — it uses `createProcessor()` directly, and there is no `codeRunner` option plumbed through the executor's WebSocket handler

### Published endpoint execution path (API container)

Published endpoint workflow runs execute **directly inside the API service process**:

1. `POST /workflows/:endpointName` hits `wrapper/api/src/routes/workflows/execution.ts`
2. `executeWorkflowEndpoint()` calls `runGraph(project, options)` from `@ironclad/rivet-node`
3. `runGraph()` calls `createProcessor()` which uses a default `NodeCodeRunner` (since no custom `codeRunner` is passed — see execution.ts lines 28-40)
4. `NodeCodeRunner.runCode()` creates a `require` via `createRequire(import.meta.url)` — NOT patched, uses standard Node resolution
5. Module resolution falls back to `NODE_PATH=/opt/rivet-executor-deps/node_modules` set in Dockerfile.api line 26
6. The executor deps are installed from `wrapper/executor/package.json` into `/opt/rivet-executor-deps/` at Docker build time

Key facts:
- The API does NOT use the executor container for published endpoints — it runs `runGraph()` in-process
- `runGraph()` already accepts a `codeRunner` option — a custom `CodeRunner` can be passed to override module resolution
- Currently no custom `codeRunner` is passed, so it defaults to `NodeCodeRunner` with standard resolution
- The API process is long-lived, so startup-time `NODE_PATH` alone cannot support hot-switching

### Docker volume layout (current)

```
rivet_data volume:
  API container:      mounted at /data/rivet-app
  Executor container: mounted at /root/.local/share/com.ironcladapp.rivet
```

These are DIFFERENT mount paths for the SAME volume. The runtime-libraries store needs to account for this.

### Dev mode (scripts/dev.mjs)

In dev mode, all three services run as local processes:
- `NODE_PATH` is set to `wrapper/executor/node_modules` (dev.mjs line 23)
- The executor runs from source via `yarn workspace @ironclad/rivet-app-executor run dev` — NOT as a bundled CJS file
- The API runs via `npm --prefix wrapper/api run dev` with tsx watch
- No Docker volumes exist; app data defaults to `.data/rivet-app` (dev.mjs line 20)

## Runtime behavior requirements

### Editor execution path

Editor-side Node workflow runs use the hosted Node executor container. That runtime must resolve packages from the active managed runtime-library release.

The existing wrapper-owned executor `require()` handling should be extended so the Code node runtime resolves from the active release directory rather than relying only on image-time dependencies.

Startup-time `NODE_PATH` or image-baked `node_modules` alone are not sufficient for this feature, because the requirement is that newly installed libraries work without restarting Docker or bouncing the executor process. The executor must determine the active release at code-execution time and create its `require()` from that release root dynamically.

#### Concrete mechanism for executor hot-switching

The current patch in `bundle-executor.cjs` (line 184) replaces the `createRequire` call with:
```js
const require = createRequire(process.cwd() + '/executor-bundle.cjs');
```

This is called **fresh on every `runCode()` invocation** — it is NOT cached across calls. This means the patch can be extended to read the active release path dynamically at each invocation.

The recommended approach:

1. Add a new patch to `bundle-executor.cjs` that replaces the `createRequire` line with code that:
   - reads the manifest.json (or a simpler "active-release" pointer file) from the runtime-libraries root
   - constructs a `createRequire()` from the active release's `node_modules` directory
   - falls back to the existing `/app/node_modules` resolution if no managed release exists
2. The read must be synchronous (the `runCode` function builds a `require` synchronously before passing it to the `AsyncFunction`). Use `fs.readFileSync()` to read the active release pointer.
3. Because `createRequire()` is called per-invocation, each code node execution naturally picks up the latest active release — no process restart needed.

Example patched code (conceptual):
```js
const __rtLibRoot = process.env.RIVET_RUNTIME_LIBRARIES_ROOT || '/data/runtime-libraries';
let __activeReleasePath = null;
try {
  const pointer = require('fs').readFileSync(
    require('path').join(__rtLibRoot, 'active-release'),
    'utf8'
  ).trim();
  if (pointer) {
    __activeReleasePath = require('path').join(__rtLibRoot, 'releases', pointer, 'node_modules');
  }
} catch {}
const require = __activeReleasePath
  ? createRequire(require('path').join(__activeReleasePath, '__virtual.cjs'))
  : createRequire(process.cwd() + '/executor-bundle.cjs');
```

Important: this reads a simple text file (`active-release`) containing just the release ID (e.g., `0002`), not the full manifest.json. This avoids JSON parsing overhead on every code node execution. The manifest.json is used by the API for management; the `active-release` file is the fast-path pointer for runtime resolution.

Because the executor behavior is currently introduced through wrapper-owned patching in `ops/bundle-executor.cjs`, the final implementation must keep the existing loud-failure patch discipline: if upstream source moves enough that the patch no longer applies, the build should fail explicitly via `replaceOrThrow`.

#### Executor in dev mode

In dev mode, the executor runs from TypeScript source (not the CJS bundle), so the `bundle-executor.cjs` patches do not apply. For dev mode, the runtime-libraries root should be included in the `NODE_PATH` environment variable set in `scripts/dev.mjs`, and the active release path should be appended dynamically or via a wrapper script. Alternatively, dev mode can use the same `active-release` pointer file approach via a small wrapper around the executor's dev entry point.

### Published endpoint execution path

Published endpoint workflow runs execute inside the API service through `runGraph(...)` from `@ironclad/rivet-node` (see `wrapper/api/src/routes/workflows/execution.ts`).

#### Concrete mechanism for API hot-switching

`runGraph()` already accepts a `codeRunner` option (defined in `RunGraphOptions` in `rivet/packages/core/src/api/createProcessor.ts` line 46). Currently, `executeWorkflowEndpoint()` does NOT pass a `codeRunner`, so the default `NodeCodeRunner` is used.

The recommended approach:

1. Create a wrapper-owned `ManagedCodeRunner` class implementing the `CodeRunner` interface (imported from `@ironclad/rivet-core`)
2. `ManagedCodeRunner` delegates to the standard `AsyncFunction` execution pattern from `NodeCodeRunner`, but creates its `require` function via `createRequire()` pointed at the active release's `node_modules`
3. On each `runCode()` call, `ManagedCodeRunner` reads the current active release pointer (same `active-release` file) and constructs a fresh `createRequire()` from that release path
4. If no managed release exists, fall back to standard `NodeCodeRunner` behavior (resolve from `NODE_PATH`)
5. Pass an instance of `ManagedCodeRunner` to `runGraph()` in `executeWorkflowEndpoint()`

This change is entirely wrapper-owned (in `wrapper/api/src/`) and does NOT require modifying anything under `rivet/`. The `CodeRunner` interface is already exported from `@ironclad/rivet-core`.

Updated `executeWorkflowEndpoint()` call:
```typescript
const outputs = await runGraph(project, {
  codeRunner: new ManagedCodeRunner(runtimeLibrariesRoot),
  projectPath: referencePath,
  datasetProvider,
  projectReferenceLoader,
  inputs: { ... },
});
```

This is the correct and clean approach because:
- it uses the existing extension point (`codeRunner` option) rather than inventing a new mechanism
- it does not require modifying `rivet/` source
- it reads the active release dynamically on each execution, enabling hot-switching
- it falls back gracefully when no managed libraries exist

### Shared volume mount for runtime-libraries

Both services need access to the same runtime-libraries store at the same path. The current `rivet_data` volume mounts at different paths in each container:
- API: `/data/rivet-app`
- Executor: `/root/.local/share/com.ironcladapp.rivet`

The solution is to introduce a **new dedicated named volume** (`rivet_runtime_libs`) and mount it at the **same path** in both containers. This avoids overloading the existing `rivet_data` volume and ensures both services see the same files at the same absolute path.

Concrete changes to `docker-compose.yml`:
```yaml
volumes:
  rivet_runtime_libs:
    driver: local

services:
  api:
    volumes:
      - rivet_runtime_libs:/data/runtime-libraries
    environment:
      - RIVET_RUNTIME_LIBRARIES_ROOT=/data/runtime-libraries

  executor:
    volumes:
      - rivet_runtime_libs:/data/runtime-libraries
    environment:
      - RIVET_RUNTIME_LIBRARIES_ROOT=/data/runtime-libraries
```

Both containers see `/data/runtime-libraries` backed by the same Docker volume. The `RIVET_RUNTIME_LIBRARIES_ROOT` env var is the single source of truth for the path.

For dev mode, `scripts/dev.mjs` should set `RIVET_RUNTIME_LIBRARIES_ROOT` to a local path like `.data/runtime-libraries`.

This also needs corresponding changes in `docker-compose.dev.yml`.

## UI design

### Trigger location

Add a new button in the bottom-left corner of the left pane when the pane is open.

The left pane is rendered by `WorkflowLibraryPanel.tsx` (`wrapper/web/dashboard/WorkflowLibraryPanel.tsx`). The button should be appended at the bottom of this component's JSX, below the folder/project tree area (after the body div that ends around line 572). The button is part of `DashboardPage` layout, not the editor iframe, so it will not affect the `/?editor` route.

This button opens a dedicated runtime library manager popup.

### Popup contents

The popup should include the following sections:

#### Installed libraries list

Shows all currently active runtime libraries with:

- package name
- installed version or requested version
- status if needed
- remove action

#### Add library form

Fields:

- package name
- version string

Actions:

- add to pending changes
- optionally validate input format client-side before sending to the server

#### Operation controls

Buttons:

- install changes
- remove selected library or apply pending removals
- close

Rules:

- conflicting buttons should be disabled while a job is running
- the user must explicitly confirm destructive actions if needed
- log visibility and final status should live primarily inside the popup instead of generating a stream of global success toasts

#### Live install log panel

A scrollable panel that shows streaming output from the backend job in real time.

This log should include enough detail to show progress such as:

- package resolution
- download progress if available
- install steps
- validation steps
- activation step
- final success or failure

#### Final verdict area

At the end of a job, the popup should clearly show:

- success
- failure
- failure reason summary

## API design

### Suggested routes

The wrapper API should expose library-management routes, for example:

- `GET /api/runtime-libraries`
  - returns current active libraries and install state
- `POST /api/runtime-libraries/install`
  - starts a background install job using requested package changes
- `POST /api/runtime-libraries/remove`
  - starts a background removal job
- `GET /api/runtime-libraries/jobs/:jobId`
  - returns job status and summary
- `GET /api/runtime-libraries/jobs/:jobId/stream`
  - streams live job logs to the UI

Route registration in `wrapper/api/src/server.ts`:
```typescript
app.use('/api/runtime-libraries', runtimeLibrariesRouter);
```

This follows the existing pattern (config, native, shell, plugins, projects, workflows routers are all registered in `server.ts` lines 17-24).

Invalid package names, malformed version strings, conflicting job requests, and impossible state transitions should return typed client-facing HTTP errors rather than generic 500 responses. Use the existing `badRequest()` helper from `wrapper/api/src/utils/httpError.ts` and extend with additional error factories as needed. This repo has already hit cases where untyped backend failures became misleading 500s, and this feature should avoid repeating that mistake.

### Job model

Install and removal operations should run as background jobs with at least these states:

- queued
- running
- validating
- activating
- succeeded
- failed

Only one mutating runtime-library job should run at a time.

If another request arrives while one is active, the API should reject it with a `409 Conflict` response containing the active job id. This is simpler and safer than implementing a queue, and the UI can use the active job id to display the ongoing operation.

The install/remove job runner should live in the API service, not in the web app or executor container. The API is already the appropriate control plane for long-running hosted operations, and this keeps websocket ownership and executor availability stable while mutations are prepared and validated.

Implementation detail: the job runner should use `child_process.spawn()` to run `npm install` (similar to the existing `execCommand()` in `wrapper/api/src/utils/exec.ts`), but with streaming instead of buffered output. Create a new `execStreaming()` utility that emits data events from stdout/stderr rather than collecting them into a string. The existing `execCommand()` buffers all output and returns it on completion — it cannot be used for SSE streaming.

### Security: RIVET_RUNTIME_LIBRARIES_ROOT must be an allowed root

The security module (`wrapper/api/src/security.ts`) validates that all file operations stay within `ALLOWED_ROOTS`. The `RIVET_RUNTIME_LIBRARIES_ROOT` path must be added to the allowed roots list. This is a simple addition to the `ALLOWED_ROOTS` array construction (around line 11-16 of security.ts). However, note that the runtime-libraries routes will likely use their own direct file operations (not the `/api/native` routes), so this may only be needed if any generic file operations touch the runtime-libraries directory.

## Streaming progress design

The most suitable log transport for this feature is Server-Sent Events.

Why SSE is a good fit:

- the data flow is one-way from server to UI
- the output is append-only log text plus status updates
- it is simpler than adding a dedicated websocket protocol
- it fits long-running install tasks well

The UI should open an `EventSource` for the active job and append received log events to the popup log panel.

### Nginx SSE configuration required

The current nginx configuration (`ops/nginx.conf`) does NOT have `proxy_buffering off` for the `/api/` location. Nginx buffers proxy responses by default, which will break SSE streaming — events will batch up and arrive in chunks instead of streaming in real time.

Add to the `/api/` location block in both `ops/nginx.conf` and `ops/nginx.dev.conf`:
```nginx
location /api/ {
    proxy_pass http://api:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 120s;
    proxy_buffering off;           # Required for SSE streaming
    proxy_cache off;               # Prevent caching of event streams
}
```

Alternatively, the SSE endpoint can set `X-Accel-Buffering: no` in the response headers, which nginx respects per-request. This is less invasive since it only affects SSE responses:
```typescript
res.setHeader('X-Accel-Buffering', 'no');
```

The per-response header approach is preferred because it does not change nginx behavior for non-SSE API routes.

### SSE read timeout

The `proxy_read_timeout 120s` on the `/api/` location may close SSE connections after 2 minutes of no data. For long-running installs, the SSE endpoint should send periodic keepalive comments (`:keepalive\n\n`) to prevent nginx from timing out the connection.

## Safe install/remove strategy

### Install flow

1. Read the current manifest and active release.
2. Build a candidate dependency set by applying the requested additions or version changes.
3. Create a fresh staging directory under `<runtime-libraries-root>/staging/`.
4. Write a generated `package.json` for the candidate runtime set.
5. Run `npm install` in the staging directory (stream stdout/stderr to SSE).
6. Validate the resulting install.
7. If validation passes, rename the staging directory to a new numbered release under `releases/`.
8. Write the new release id to the `active-release` pointer file (write to temp file, then rename for near-atomic switch).
9. Update `manifest.json` with the new release metadata.
10. Future executions in both runtimes will resolve against the new active release without restarting containers or reconnecting the hosted executor websocket, because both the executor patch and the `ManagedCodeRunner` read the `active-release` pointer on each invocation.

### Remove flow

1. Read the current manifest and active release.
2. Build a candidate dependency set with the requested package removed.
3. Create a fresh staging directory.
4. Generate the candidate `package.json`.
5. Run a clean install for the reduced dependency set.
6. Validate the candidate.
7. Promote only if validation succeeds.
8. Keep the previous release active if anything fails.

### Validation requirements

A candidate release should be validated before activation. Validation may include:

- package manifest integrity checks
- ensuring all requested dependencies resolved successfully
- `require.resolve()` checks for each installed package (using `createRequire()` pointed at the candidate release)
- optional isolated smoke test loading for changed packages

Validation runs in the API process. The API can `createRequire()` from the candidate's `node_modules` and verify each package resolves.

The earlier plan mentioned "verification that the generated release can be resolved from both wrapper runtime paths." Since both paths now use the same volume and the same `active-release` pointer mechanism, this simplifies to verifying the packages resolve from the candidate directory.

Only a fully validated release should become active.

## Runtime activation model

### Important constraint

Node processes cache modules. That means changing a library on disk does not necessarily replace already loaded module instances inside a long-lived process.

Because of that, the system should treat runtime-library activation like a release switch:

- new executions should resolve packages from the new active release
- in-flight executions can continue using whatever they already loaded
- failed or partial installs must never affect the current active release
- release-specific require roots should be used so Node module-cache keys naturally differ between releases instead of accidentally reusing a stale cached module from an older path

The versioned release directory model (`releases/0001/node_modules/sharp`, `releases/0002/node_modules/sharp`) naturally gives each release distinct module cache keys because `require.cache` keys by absolute path. A module loaded from `releases/0001/node_modules/sharp/index.js` will not collide with one from `releases/0002/node_modules/sharp/index.js`.

### Fallback to image-baked dependencies

When no managed runtime libraries are installed (no `active-release` file exists), both execution paths must continue to work using the existing image-baked dependencies:
- Executor: `NODE_PATH=/app/node_modules` (Dockerfile.executor)
- API: `NODE_PATH=/opt/rivet-executor-deps/node_modules` (Dockerfile.api)

This ensures the feature is backward-compatible and does not break existing setups. The `wrapper/executor/package.json` dependencies (currently `sharp`) continue to work as before until the user installs managed libraries.

Once a managed release exists, the managed release takes precedence for `require()` resolution, with the image-baked deps as a fallback (Node's `createRequire` respects `NODE_PATH` after checking its own resolution root).

## Persistence and startup reconciliation

Installed libraries must survive:

- `npm run dev`
- Docker container restarts
- image rebuilds

To support that, the manifest and releases should live in the `rivet_runtime_libs` named Docker volume, mounted at the same path in both services.

On startup, the API service should:

- check if `RIVET_RUNTIME_LIBRARIES_ROOT` exists and contains a manifest
- if the `active-release` pointer file references a release directory that does not exist, attempt to reconstruct it from the desired dependency set in `manifest.json`
- if reconstruction fails, log a clear error and continue without managed libraries (falling back to image-baked deps)
- never auto-activate a reconstructed release that fails validation

Docker/dev wiring for that location uses an explicit `RIVET_RUNTIME_LIBRARIES_ROOT` environment variable, avoiding ambiguous relative paths.

For dev mode, `scripts/dev.mjs` should set `RIVET_RUNTIME_LIBRARIES_ROOT` to `path.join(rootDir, '.data', 'runtime-libraries')` and create the directory if it does not exist.

## Failure isolation guarantees

The design must guarantee the following:

- a failed install does not modify the currently active release
- a failed removal does not remove the currently active release
- published endpoints keep using the previous good release if an update fails
- the editor executor keeps using the previous good release if an update fails
- the user receives the full logs and a final failure verdict

This is a hard requirement, not a best-effort goal.

## Proposed implementation phases

### Phase 1: backend manifest, job framework, and container wiring

Implement:

- `RIVET_RUNTIME_LIBRARIES_ROOT` environment variable in both docker-compose files and dev.mjs
- `rivet_runtime_libs` named volume in docker-compose.yml and docker-compose.dev.yml, mounted at `/data/runtime-libraries` in both api and executor services
- runtime library manifest storage (`manifest.json` and `active-release` pointer file)
- background job state tracking (in-memory, single-job-at-a-time)
- API routes for list, install, remove, and job status (`wrapper/api/src/routes/runtime-libraries.ts`)
- route registration in `wrapper/api/src/server.ts`
- streaming `execStreaming()` utility for `child_process.spawn` with event-based output (`wrapper/api/src/utils/exec.ts` or new file)
- SSE log streaming endpoint for job output
- `X-Accel-Buffering: no` header on SSE responses for nginx compatibility

Deliverable:

- backend-only library job system with observable progress, testable via curl

### Phase 2: safe staged installer

Implement:

- staging directory creation under `<runtime-libraries-root>/staging/`
- generated candidate `package.json` with only the desired runtime dependencies
- `npm install` execution in staging directory with streamed log capture
- candidate validation using `createRequire()` from candidate directory
- promotion to new numbered release via directory rename
- `active-release` pointer update via write-to-temp-then-rename
- `manifest.json` update with release metadata
- rollback behavior: simply leave `active-release` unchanged on failure, clean up staging directory

Deliverable:

- safe persistent runtime-library release management, testable via API calls

### Phase 3: shared runtime resolution

Implement:

- `ManagedCodeRunner` class in `wrapper/api/src/` implementing `CodeRunner` interface from `@ironclad/rivet-core`
  - reads `active-release` pointer on each `runCode()` call
  - constructs `createRequire()` from active release `node_modules`
  - falls back to default `NodeCodeRunner` behavior when no managed release exists
- update `executeWorkflowEndpoint()` in `wrapper/api/src/routes/workflows/execution.ts` to pass `codeRunner: new ManagedCodeRunner(runtimeLibrariesRoot)` to `runGraph()`
- new build-time patch in `ops/bundle-executor.cjs` for the `NodeCodeRunner.ts` require line:
  - replace the current static `createRequire(process.cwd() + '/executor-bundle.cjs')` with dynamic resolution that reads the `active-release` pointer file
  - use `replaceOrThrow()` to maintain loud-failure patch discipline
  - fall back to existing behavior when no managed release exists
- dev mode support: update `scripts/dev.mjs` to set `RIVET_RUNTIME_LIBRARIES_ROOT` and ensure the executor dev process can access the same directory

Deliverable:

- parity between editor execution and published endpoint execution
- hot-switching works without container restarts

### Phase 4: UI popup

Implement:

- new button at the bottom of `WorkflowLibraryPanel.tsx` (after the body div, around line 572)
- new `RuntimeLibrariesModal.tsx` component in `wrapper/web/dashboard/`
- new `runtimeLibrariesApi.ts` client API helper in `wrapper/web/dashboard/` (following the pattern of `workflowApi.ts`)
- installed library list with package name, version, remove action
- add library form with package name and version fields
- install/remove controls with disabled state during active jobs
- live log viewer using `EventSource` for SSE streaming
- success and error states shown inside the popup
- no new Vite aliases, no editor-wide component overrides
- styles in a new `RuntimeLibrariesModal.css` co-located with the component

Deliverable:

- end-to-end usable library-management UI

### Phase 5: startup reconciliation and hardening

Implement:

- startup validation of manifest and active release in the API server startup path
- recovery path when releases are missing or corrupt (re-install from manifest desired set)
- cleanup policy for old releases (keep last N releases, configurable)
- SSE keepalive comments to prevent nginx timeout during long installs
- concurrency protections: `409 Conflict` response when a job is already active
- add test for `/?editor` route to confirm no regression

Deliverable:

- resilient long-term runtime library management

## Suggested file areas to touch

### Web UI

Files to create:

- `wrapper/web/dashboard/RuntimeLibrariesModal.tsx` — the popup component
- `wrapper/web/dashboard/RuntimeLibrariesModal.css` — popup styles
- `wrapper/web/dashboard/runtimeLibrariesApi.ts` — client API helper (following `workflowApi.ts` pattern)

Files to modify:

- `wrapper/web/dashboard/WorkflowLibraryPanel.tsx` — add trigger button at bottom of panel (after line 572)
- `wrapper/web/dashboard/DashboardPage.tsx` — may need to manage modal open/close state if lifted out of the panel

Do NOT modify:

- `wrapper/web/vite.config.ts` — no new aliases needed
- anything under `wrapper/web/overrides/` or `wrapper/web/shims/` — not relevant to this feature

### API

Files to create:

- `wrapper/api/src/routes/runtime-libraries.ts` — route handler with list, install, remove, job status, SSE stream endpoints
- `wrapper/api/src/runtime-libraries/manifest.ts` — manifest and active-release pointer read/write helpers
- `wrapper/api/src/runtime-libraries/job-runner.ts` — background job execution (spawn npm, stream output, validate, promote)
- `wrapper/api/src/runtime-libraries/managed-code-runner.ts` — `ManagedCodeRunner` implementing `CodeRunner` interface

Files to modify:

- `wrapper/api/src/server.ts` — register the new `runtimeLibrariesRouter` (add one line at lines 17-24)
- `wrapper/api/src/routes/workflows/execution.ts` — pass `codeRunner: new ManagedCodeRunner(root)` to `runGraph()` (change lines 28-40)
- `wrapper/api/src/utils/exec.ts` — add `execStreaming()` variant that emits data events (or create a new file)

### Runtime and container wiring

Files to modify:

- `ops/Dockerfile.api` — add `RUN mkdir -p /data/runtime-libraries` (or let the volume handle it)
- `ops/Dockerfile.executor` — add `ENV RIVET_RUNTIME_LIBRARIES_ROOT=/data/runtime-libraries`
- `ops/docker-compose.yml` — add `rivet_runtime_libs` volume, mount in both api and executor, add env var
- `ops/docker-compose.dev.yml` — same volume and env var additions for dev mode
- `ops/bundle-executor.cjs` — add new patch to `NodeCodeRunner.ts` require line for dynamic release resolution (replace the existing static patch with a dynamic one)
- `ops/nginx.conf` — optionally add `proxy_buffering off` to `/api/` block (or rely on per-response header)
- `ops/nginx.dev.conf` — same nginx change if needed
- `scripts/dev.mjs` — set `RIVET_RUNTIME_LIBRARIES_ROOT` env var (add around line 20)

## Testing plan

### Functional tests

- add `sharp` from the popup
- observe live install logs in the UI
- use `require('sharp')` in a Code node in the editor
- publish the workflow and call the endpoint
- confirm both execution paths work
- confirm the Node-mode Run button remains available before, during, and after successful library operations
- confirm the direct `/?editor` route still renders correctly after the UI work, proving the feature did not reintroduce a shared-bundle regression through over-broad aliases

### Failure tests

- request a non-existent package
- request an invalid version
- simulate install failure (e.g., disconnect network during install)
- confirm the old active runtime still works in both editor and endpoint modes
- confirm the `active-release` pointer file is NOT modified on failure

### Persistence tests

- install multiple packages
- restart the dev stack (docker-compose down/up or kill dev.mjs and restart)
- rebuild the dev stack (docker-compose build + up)
- confirm installed libraries remain available automatically
- confirm `manifest.json` and `active-release` file survive across restarts

### Concurrency tests

- try to start a second install while one is already running
- confirm the API returns `409 Conflict` with the active job id
- confirm the UI shows the active job and disables the install button
- confirm repeated status refreshes do not cause object-identity-driven request loops in the dashboard UI

### Dev mode tests

- run `npm run dev` (local mode, no Docker)
- install a library via the UI
- confirm the library is available in both editor and endpoint execution
- confirm the library persists after restarting the dev stack

### Edge case tests

- start with no managed libraries (fresh install) — confirm existing image-baked deps still work
- install a library that conflicts with an image-baked dep (e.g., different `sharp` version) — confirm managed version takes precedence
- delete the `active-release` file manually — confirm graceful fallback

## Open questions

- should multiple package edits be batched into one install operation or applied one-by-one
- should removals require explicit confirmation if a library is currently listed in the active manifest
- should old inactive releases be garbage-collected automatically or only on demand
- should there be a manual "rebuild active runtime libraries" action for recovery
- should package names be restricted or allow any npm package the environment can install
- should the `fs.readFileSync` in the executor's per-invocation active-release check be cached with a short TTL (e.g., 5 seconds) to reduce filesystem reads under heavy load, or is the OS page cache sufficient

## Recommended next step

Implement the container wiring first (new volume, env var, docker-compose changes, dev.mjs changes) to establish the shared runtime-libraries root. Then implement the backend manifest, job runner, and SSE streaming. That creates the foundation needed for both the UI and the safe runtime switching model.

Once that exists, implement `ManagedCodeRunner` and the executor patch to wire both runtime contexts to the managed active release, then build the popup UI on top of the stable backend.
