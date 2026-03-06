# Findings and Problems: Self-hosted Rivet Wiring

This file captures both critical wiring findings and the concrete problems encountered while getting the hosted wrapper + Docker stack running reliably.

This document is intended as a developer handoff.

## Findings

## 1) App behavior that controls execution buttons

- Run button visibility is controlled in `rivet/packages/app/src/components/ActionBar.tsx`:
  - `canRun = (remoteDebugger.started && !remoteDebugger.reconnecting) || selectedExecutor === 'browser'`
- Implication:
  - Browser mode can always run.
  - Node mode requires a healthy remote debugger WebSocket connection.
- Practical consequence:
  - If the Run button disappears only in Node mode, the first thing to inspect is `remoteDebugger.started`, reconnect state, and the remote debugger socket lifecycle.

## 2) Critical hosted override behavior

### `useGraphExecutor` selection must follow user mode exactly

- Bad logic from upstream-style behavior:
  - `remoteExecutor.active || selectedExecutor === 'nodejs' ? remoteExecutor : localExecutor`
- Why this breaks hosted mode:
  - Once WS has ever connected, `remoteExecutor.active` can keep routing runs to remote executor.
  - Browser mode then incorrectly runs remotely.
  - That can surface as executor-side failures such as `Graph not found, and no main graph specified.` even though the user selected Browser executor.
- Correct hosted logic:
  - `selectedExecutor === 'nodejs' ? remoteExecutor : localExecutor`

## 3) WebSocket routing requirements (Docker + nginx)

### Frontend URLs

- Hosted URLs should be proxy-based, not direct container ports:
  - Internal executor WS: `/ws/executor/internal`
  - Debugger WS: `/ws/executor`
- Build from `window.location` in `wrapper/shared/hosted-env.ts`.

### nginx path rewrite is required

- nginx must rewrite paths when proxying:
  - `/ws/executor/internal` -> `http://executor:21889/internal`
  - `/ws/executor` -> `http://executor:21889/`
- If not rewritten, executor receives the wrong path and the WS fails or reconnects uselessly.

### Executor must bind to Docker network interface

- Upstream debugger server defaults to host `localhost`.
- In containerized deployment, this blocks other containers such as nginx from connecting.
- It must bind to `0.0.0.0` for Docker networking.
- We patch this in the Docker bundle step rather than editing upstream source directly.

## 4) Vite alias/override matching gotcha

- Vite `resolve.alias` regex matches the **raw import specifier string**, not resolved file paths.
- Patterns like `.*\/hooks\/useGraphExecutor` do **not** catch sibling imports like `./useGraphExecutor`.
- Use relative-import-aware patterns like:
  - `^\.\.?\/(?:.*\/)?useGraphExecutor(\.js|\.ts)?$`
- For generic names like `settings` or `datasets`, keep patterns restricted to relative imports.

## 5) Override file path depth gotcha

- Nested override files are easy to break with the wrong `../../..` depth.
- Example of a previously fixed issue:
  - `overrides/utils/globals/ioProvider.ts` needed 5 `..` segments to reach repo-root imports from `rivet/...`.
- Typical symptom:
  - Vite build fails with unresolved relative imports from override files.

## 6) Executor image build findings

- Upstream `app-executor` build script runs `pkg` plus `rustc`-related steps intended for native sidecar artifacts.
- That is unnecessary in Docker runtime for the web wrapper and caused `spawn rustc ENOENT`.
- Stable Docker approach:
  - Build `rivet-core` and `rivet-node`.
  - Bundle executor entry with esbuild only.
  - Run the generated JS bundle with Node in the container.

## 7) Browser unsaved-project behavior that must keep working

- Confirmed good behavior now:
  - A newly created, unsaved project runs in Browser executor on the first attempt.
  - No page refresh is required.
  - Current graph state is already present in `project.graphs` when the run happens.
- Useful console signals during validation:
  - `[HOSTED-DEBUG] tryRunGraph COMPLETED`
  - `[HOSTED-DEBUG] useGraphExecutor render: executor=browser, graph.id=..., graph.nodes=..., project.graphs keys=[<currentGraphId>]`
- This is an important regression guard because earlier failures in this area were easy to mistake for Node executor problems.

## 8) Monaco worker wiring gotcha (Code node editor)

- Symptom when opening a Code node:
  - Browser console showed Monaco errors such as:
    - `Uncaught Error: Unexpected usage`
    - `Uncaught SyntaxError: Unexpected token '<'` in `editor.worker.bundle.js`
- Root cause:
  - Monaco worker URL resolved, but worker file was missing from served build output.
  - Browser received `index.html` fallback instead of JS worker, so the first byte was `<`.
- Why this happened in the wrapper:
  - Vite `root` points to upstream app, while `build.outDir` points to wrapper dist.
  - `vite-plugin-monaco-editor` needed explicit output path alignment in this setup.
- Fix:
  - In `wrapper/web/vite.config.ts`, set Monaco plugin options:
    - `publicPath: 'monacoeditorwork'`
    - `customDistPath: (_root, buildOutDir) => resolve(buildOutDir, 'monacoeditorwork')`

## 9) Non-negotiable project rule

- Do not modify vendor upstream source under `rivet/` for wrapper-specific behavior.
- Keep hosted adaptations in `wrapper/` and `ops/`.

## Problems

## Ongoing

### 1) Unsaved project graph upload to Node executor

- **Status**: ongoing
- **Current symptom**:
  - In Node mode, the executor has reported `Graph not found, and no main graph specified.` for unsaved workflows.
- **What we learned**:
  - New projects are initialized with `project.graphs = {}`.
  - The current graph initially lives in `graphState` and is not guaranteed to already exist in `project.graphs` unless the run path explicitly merges it in.
  - Browser execution can work even for unsaved graphs because local execution builds a temporary project that injects the current graph into `project.graphs` before running.
- **What we tried**:
  - Instrumented `useRemoteExecutor.ts` to log the graph id, project graph keys, main graph id, and upload capability before sending `set-dynamic-data` and `run`.
  - Instrumented the executor bundle to log the `project.graphs` keys received by the `set-dynamic-data` handler.
  - Ensured hosted `useGraphExecutor` routes Browser mode to local execution only.
- **Partial success**:
  - Browser unsaved first-run is now confirmed working.
  - A simple one-node workflow now also runs in Node executor mode.
- **What remains open**:
  - Unsaved-project-specific Node execution should still be rechecked explicitly, since the latest validation was a simple workflow success rather than a dedicated unsaved-upload regression test.

## Done

### 2) Wrapper web app failed to boot because browser bundle pulled Node-oriented runtime code

- **Status**: done
- **Symptoms**:
  - Browser console showed `ReferenceError: process is not defined`.
  - After that was fixed, it showed `ReferenceError: Buffer is not defined`.
  - After that, startup failed with `TypeError: Class extends value undefined is not a constructor or null`.
- **Root causes**:
  - Wrapper build was resolving some dependencies to Node-oriented entrypoints instead of browser-safe ones.
  - The browser bundle pulled in Node-oriented Google SDK/auth code through the vendored core Google plugin path.
- **Fixes**:
  - Added a minimal browser-safe `process` shim in `wrapper/web/entry.tsx` before loading the upstream app.
  - Forced `nanoid` and `nanoid/non-secure` to browser-safe entrypoints in `wrapper/web/vite.config.ts`.
  - Added a browser-safe override for `rivet/packages/core/src/plugins/google/google.ts` under `wrapper/web/overrides/core/plugins/google/google.ts`.
  - Added targeted Vite resolution so the relevant Google node path uses the wrapper override.
  - Forced `@google/genai` to resolve to `node_modules/@google/genai/dist/web/index.mjs`.
- **Result**:
  - Wrapper web app now loads successfully instead of failing during startup.
  - A simple workflow has been validated to run in both Browser and Node execution modes.

### 3) Node executor mode made the Run button disappear

- **Status**: done
- **Symptom**:
  - Switching to Node executor caused the Run button to disappear because `ActionBar` depends on `remoteDebugger.started && !remoteDebugger.reconnecting`.
- **Root causes**:
  - Hosted WebSocket URLs initially targeted the wrong endpoints for Docker/nginx deployment.
  - The executor debugger server was not reachable across the Docker network while bound to `localhost`.
  - Hosted remote debugger state handling had drifted from upstream atom-backed semantics, so UI state could become inaccurate across socket lifecycle changes.
- **Fixes**:
  - Moved hosted executor/debugger URLs to proxy-based paths derived from `window.location`.
  - Added nginx proxy routing and path rewrites for `/ws/executor/internal` and `/ws/executor`.
  - Patched the executor debugger bind host to `0.0.0.0` in the Docker bundle flow.
  - Rewrote `wrapper/web/overrides/hooks/useRemoteDebugger.ts` to restore atom-backed state semantics while keeping a module-level WebSocket singleton.
  - Ensured hosted executor selection follows the user choice exactly via the `useGraphExecutor` override.
- **Result**:
  - Node executor mode now keeps the Run button available for the validated simple workflow.
  - The same simple workflow has been confirmed to run successfully in both Browser and Node execution modes.

### 4) `useRemoteDebugger.started` behaved incorrectly across modes

- **Status**: done
- **Problem**:
  - Remote debugger state handling caused incorrect UI behavior, including stale or misleading remote-debugger state across Browser and Node modes.
- **Fix**:
  - Reimplemented the hosted `useRemoteDebugger` override so it synchronizes with the upstream `remoteDebuggerState` atom and updates `started`, `reconnecting`, `remoteUploadAllowed`, and `isInternalExecutor` from actual WebSocket lifecycle events.
- **Result**:
  - Browser mode no longer depends on stale remote debugger activity.
  - Node-mode UI state now reflects the actual connection lifecycle for the validated flow.

### 5) Browser executor for unsaved new projects only worked after refresh
 
- **Status**: done
- **Symptom**:
  - A freshly created unsaved project did not run immediately in Browser executor.
  - After refreshing the page, it started working.
- **Why it was confusing**:
  - The failure looked similar to Node executor graph-upload problems, but the user had selected Browser executor.
  - This made it easy to chase the wrong code path.
- **What we tried**:
  - Added diagnostics around `useGraphExecutor` and run invocation.
  - Verified which executor path was actually selected at runtime.
  - Confirmed whether current graph state was present in `project.graphs` during the run.
- **Resolution / current verified behavior**:
  - Fresh unsaved Browser execution now works without refresh.
  - Console confirms:
    - `[HOSTED-DEBUG] tryRunGraph COMPLETED`
    - `project.graphs keys=[<currentGraphId>]`
 
### 6) Browser mode was incorrectly routed to remote executor after WS activity
 
- **Status**: done
- **Symptom**:
  - Browser mode could end up using remote execution after any remote WS connection had been established.
- **Root cause**:
  - Hosted wrapper inherited upstream-style selection logic based on `remoteExecutor.active`.
- **Fix**:
  - Overrode `useGraphExecutor` so hosted mode uses:
    - `selectedExecutor === 'nodejs' ? remoteExecutor : localExecutor`
- **Result**:
  - Browser mode now follows the user selection instead of stale remote activity.
 
### 7) WebSocket connection targeted `ws://localhost:21889/internal`
 
- **Status**: done
- **Symptom**:
  - Hosted browser attempted to connect directly to executor localhost instead of going through nginx.
- **Fixes applied**:
  - Introduced hosted env-based WS URLs.
  - Routed traffic through nginx proxy endpoints.
  - Added nginx path rewrites for executor endpoints.
- **Result**:
  - WS routing now follows the hosted deployment design instead of trying to talk directly to container-local ports.
 
### 8) Executor was not reachable from nginx inside Docker
 
- **Status**: done
- **Symptom**:
  - Even with proxying configured, nginx could not reliably reach the executor debugger server.
- **Root cause**:
  - Executor server bound to `localhost` inside the container.
- **Fix**:
  - Patch executor debugger bind host from `localhost` to `0.0.0.0` during Docker bundle creation.
- **Result**:
  - Executor becomes reachable over the Docker network.
 
### 9) Monaco Code node worker loading failed
 
- **Status**: done
- **Symptom**:
  - Opening a Code node produced Monaco errors such as `Unexpected usage` and `Unexpected token '<'`.
- **Root cause**:
  - Worker assets were not emitted to the location the served app expected.
- **Fix**:
  - Aligned Monaco plugin output with wrapper build layout in `wrapper/web/vite.config.ts`.
- **Result**:
  - Code node editor worker assets load correctly.
