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
- Useful console signals during validation when `VITE_RIVET_DEBUG_LOGS=true`:
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

## 9) Node executor console logs can be surfaced in the browser console

- In desktop Rivet, Node-executor logs appear in the browser console because the local sidecar stdout/stderr is mirrored there.
- In the hosted wrapper, Node Code nodes originally received the real Node `console`, so `console.log(...)` only reached executor container stdout and did not reach the browser.
- Hosted fix:
  - Patch the Docker executor bundle in `ops/bundle-executor.cjs` instead of editing vendored upstream source.
  - Forward executor lifecycle logs and Code-node console calls as websocket `trace` messages.
  - Handle those `trace` messages in `wrapper/web/overrides/hooks/useRemoteExecutor.ts` and print them in the browser console with sidecar-style prefixes.
- Current validated behavior:
  - In Node executor mode, browser devtools now show entries such as `sidecar stdout Running graph ...` and `sidecar stdout Hello` for simple `console.log(...)` calls from Code nodes.
  - `console.error(...)` from the executor path is surfaced as `sidecar stderr ...`.

## 10) Hosted wrapper debug diagnostics are now env-gated

- Temporary hosted diagnostics such as `[HOSTED-DEBUG] ...`, `[HOSTED-OVERRIDE] ...`, and `[executor-ws] ...` were useful during wiring, but they clutter normal browser-console usage.
- Current behavior:
  - They are gated behind `VITE_RIVET_DEBUG_LOGS`.
  - Default should be `false` for normal usage.
  - Set `VITE_RIVET_DEBUG_LOGS=true` when debugging hosted wrapper wiring or websocket behavior.
- Important implementation detail:
  - This is a Vite build-time flag for the web app, so changing it requires rebuilding the web frontend/container.
  - The gate now lives in one shared helper in `wrapper/shared/hosted-env.ts`, so hosted overrides do not each need their own ad hoc debug logging wrapper.

## 11) Hosted execution overrides were simplified back toward upstream shape

- `wrapper/web/overrides/hooks/useGraphExecutor.ts` now stays close to upstream behavior.
- The hosted override keeps only the wrapper-specific differences that matter:
  - Node mode should select the remote executor based on user choice rather than transient websocket connection state.
  - The debugger should connect to the hosted executor websocket URL from `wrapper/shared/hosted-env.ts`.
- Wrapper-specific render logging and the extra `tryRunGraph` wrapper used during debugging were removed.
- Connection ownership is clearer now:
  - `useGraphExecutor.ts` decides when Node mode should connect or disconnect.
  - `useRemoteDebugger.ts` owns websocket lifecycle.
  - `useRemoteExecutor.ts` owns remote run semantics and trace handling.

## 12) Executor bundle patching is now safer to maintain

- The hosted executor patch in `ops/bundle-executor.cjs` still relies on string-based source patching so wrapper behavior stays outside vendored `rivet/` code.
- That patching is now guarded with explicit failure messages instead of silent `replace(...)` calls.
- The matcher was also made tolerant of `LF` vs `CRLF` line endings, because the executor bundle is built from Windows-authored source but runs in Linux containers during Docker builds.
- Practical outcome:
  - if upstream executor code meaningfully changes, the Docker build now fails loudly at the exact patch point instead of silently dropping hosted behavior.

## 13) Non-negotiable project rule

- Do not modify vendor upstream source under `rivet/` for wrapper-specific behavior.
- Keep hosted adaptations in `wrapper/` and `ops/`.

## 14) Dashboard-era component aliases can break the editor globally

- The hosted editor breakage at `/?editor` turned out to **not** be an iframe-isolation problem.
- Root cause:
  - `wrapper/web/vite.config.ts` had gained four dashboard-era aliases:
    - `LeftSidebar`
    - `DebuggerConnectPanel`
    - `NoProject`
    - `useContextMenu`
  - Those aliases affected the upstream editor bundle globally, including the direct `/?editor` route where no dashboard shell or iframe composition was involved.
- Why this was misleading:
  - The dashboard route was visibly broken, so it was easy to assume the shell or iframe integration was the main issue.
  - But Vite aliases apply at build/import time, not only when a particular route is rendered.
  - That means a route can be broken even if the dashboard UI itself is not mounted, as long as the aliased modules are imported by the upstream app.
- Important practical rule:
  - Prefer narrow hook/state/module aliases that preserve upstream component structure.
  - Avoid adding component-level aliases for major viewport-owning UI unless there is a demonstrated hosted-only requirement that cannot be handled more locally.
  - Before blaming iframe composition or CSS containment, always test `/?editor` directly to determine whether the regression is actually in the shared app bundle.
- Confirmed fix:
  - Remove the four dashboard-era aliases above.
  - Keep the existing lower-level hosted aliases such as `settings`, `useRemoteDebugger`, `useRemoteExecutor`, `useGraphExecutor`, and similar wrapper-specific modules.
- Why removing them was safe:
  - The upstream components already received the hosted behavior they needed through the existing lower-level module aliases.
  - The component-level aliases were redundant and introduced layout/positioning drift.
  - After removing them and rebuilding Docker images, the editor was confirmed working again both at `http://localhost:8080/?editor` and inside the dashboard at `http://localhost:8080/`.

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

### 2) Workflow dashboard integration initially broke API routing and editor layout

- **Status**: resolved
- **Goal of this work**:
  - Turn the hosted wrapper from an editor-first experience into a workflow workspace with a persistent `Folders` panel on the left.
  - Let users create folders, create `.rivet-project` files inside those folders, and open those projects in the existing Rivet editor.
  - Keep the host-side `workflows/` directory as the source of truth for persisted workflow assets.
  - Reuse the existing project open/load/save path instead of inventing a separate editor state reconstruction path.
- **Initial visible failures**:
  - The left `Folders` pane returned frontend HTML instead of workflow JSON.
  - The main Rivet editor UI became visually broken, with collapsed viewport, overlapping header/tabs, misplaced context menus, and misaligned fixed-position panels.
- **Why this work is tricky**:
  - Upstream Rivet assumes a full-window editor with many UI elements positioned relative to the viewport rather than to an arbitrary nested layout box.
  - The hosted wrapper must preserve the existing browser-safe boot path in `wrapper/web/entry.tsx`.
  - The dashboard must not create a second bootstrapped app, disturb Monaco worker output, or replace the authoritative project-open and execution wiring.
  - The wrapper must stay within the vendor boundary and keep dashboard behavior in `wrapper/` and `ops/`, not by editing vendored upstream files under `rivet/`.
- **What we implemented for the dashboard feature**:
  - Added a dedicated workflow-library backend in `wrapper/api/src/routes/workflows.ts`.
  - Added dedicated workflow-root configuration in `wrapper/api/src/security.ts` and container wiring in `ops/docker-compose.yml` / `ops/Dockerfile.api`.
  - Added wrapper frontend dashboard code in:
    - `wrapper/web/dashboard/types.ts`
    - `wrapper/web/dashboard/workflowApi.ts`
    - `wrapper/web/dashboard/useOpenWorkflowProject.ts`
    - `wrapper/web/dashboard/WorkflowLibraryPanel.tsx`
    - `wrapper/web/dashboard/WorkflowDashboardShell.tsx`
  - Added wrapper overrides and aliases so the dashboard could compose around the existing app without modifying vendored upstream source.
- **First dashboard integration approach that we tried**:
  - Wrap the upstream Rivet app inside a dashboard shell with:
    - a fixed left sidebar
    - a resized main pane for the editor
  - This was initially wired through `wrapper/web/entry.tsx` and wrapper-owned composition around the existing app boot path.
- **What broke with the first approach**:
  - The dashboard shell changed the layout assumptions of the embedded editor.
  - Rivet components that expect viewport-relative positioning started behaving as if their available screen geometry had changed in unsupported ways.
  - Symptoms included overlapping header/tabs, misplaced context menus, tiny or clipped editor viewport, and misaligned node settings panels.
- **Runtime error encountered during the first approach**:
  - The dashboard initially crashed with:
    - `TypeError: Cannot read properties of undefined (reading 'css')`
  - This came from dashboard components using Emotion `css`-prop behavior in a wrapper build where that runtime assumption was not being satisfied.
- **What we tried for the runtime styling crash**:
  - Replaced Emotion `css` usage in `WorkflowDashboardShell.tsx` and `WorkflowLibraryPanel.tsx` with plain CSS strings injected via `<style>` tags and ordinary `className` usage.
- **Result of that attempt**:
  - The runtime crash was removed.
  - The dashboard components rendered, but the deeper layout regressions remained.
- **What we tried for context menu misplacement**:
  - Added a wrapper override for `useContextMenu` that translates click coordinates from viewport space into `.node-canvas` local coordinates before positioning the menu.
- **Result of that attempt**:
  - It was a targeted mitigation for one symptom only.
  - It did not solve the broader problem that the editor was now living inside a wrapper-owned layout model that upstream Rivet does not naturally expect.
- **What we tried for fixed-position/editor-size regressions**:
  - Added CSS in `WorkflowDashboardShell.tsx` to constrain the embedded `.app` and `.node-canvas` to the dashboard main pane.
  - Added/adjusted wrapper overrides for some components such as `LeftSidebar`, `DebuggerConnectPanel`, and `NoProject` to account for the dashboard sidebar.
  - Considered and briefly used additional component overrides for positioning-sensitive UI.
- **Result of those attempts**:
  - These changes acted more like symptom patches than a stable architectural fit.
  - The editor still showed major visual regressions because more upstream UI assumes full-viewport ownership.
- **What we tried for the workflow API failure**:
  - Added clearer response validation in `wrapper/web/dashboard/workflowApi.ts` so that HTML fallback responses are reported explicitly instead of surfacing only as `Unexpected token '<'` JSON parse errors.
  - Made the hosted API base URL configurable through `wrapper/shared/hosted-env.ts` using `VITE_RIVET_API_BASE_URL`.
  - Updated local Docker config so the browser could call the API directly at `http://localhost:3100/api` instead of depending purely on nginx proxy routing.
  - Exposed the API container on host port `3100` and passed the API base URL into the web build.
- **Result of those API attempts**:
  - API routing was corrected and the workflow sidebar now reaches the intended JSON API in the validated local stack.
- **Second dashboard integration approach that we tried**:
  - Move away from a layout-constraining shell and convert the dashboard into an overlay model:
    - Rivet keeps the full viewport
    - the `Folders` pane is rendered as a fixed overlay on top of the app
  - The intent was to preserve upstream Rivet's viewport-based positioning model instead of forcing it into a smaller content pane.
- **What finally resolved the editor regression**:
  - The remaining editor breakage was traced to four dashboard-era Vite aliases in `wrapper/web/vite.config.ts`, not to iframe isolation itself.
  - Those aliases overrode upstream `LeftSidebar`, `DebuggerConnectPanel`, `NoProject`, and `useContextMenu` modules globally.
  - Removing those four aliases restored the upstream editor behavior while preserving the necessary lower-level hosted module overrides.
- **Verification that confirmed the root cause**:
  - The editor was tested directly at `http://localhost:8080/?editor`.
  - It was broken before removing the aliases and correct after removing them.
  - Because `/?editor` does not depend on the dashboard shell being rendered, this proved the regression lived in the shared built app bundle rather than in iframe composition alone.
- **Current verified result**:
  - `http://localhost:8080/?editor` renders correctly again.
  - `http://localhost:8080/` also renders correctly with the dashboard integration.
  - The earlier component-level dashboard overrides should be treated as a regression source and should not be reintroduced without a narrowly justified need.
- **Important lesson from this effort**:
  - The workflow dashboard problem is not just a cosmetic CSS issue.
  - It is an integration-boundary problem involving:
    - runtime routing of API requests
    - viewport ownership assumptions inside the upstream editor
    - the constraint that wrapper code must not fork or directly edit vendored upstream UI
  - A second key lesson is that build-time alias scope must be treated as global: route-local UI experiments can still destabilize the editor route if they replace shared upstream modules.

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
  - Console confirms when `VITE_RIVET_DEBUG_LOGS=true`:
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

### 10) Node executor `console.log(...)` output was missing from the browser console

- **Status**: done
- **Symptom**:
  - In Node executor mode, Code-node logs such as `console.log('Hello')` were visible in executor/container stdout but not in the browser devtools console.
- **Root cause**:
  - Hosted web mode does not have the desktop sidecar stdout bridge.
  - Node Code nodes were running with the real Node `console`, so their output never became remote debugger `trace` events.
- **Fix**:
  - Patched `ops/bundle-executor.cjs` so the hosted executor bundle:
    - forwards executor lifecycle logs as websocket `trace` messages
    - wraps the console passed to Node Code execution and forwards console method calls through the same trace channel
  - Updated `wrapper/web/overrides/hooks/useRemoteExecutor.ts` so structured trace payloads are logged to the browser console as `sidecar stdout ...` and `sidecar stderr ...`.
- **Result**:
  - Hosted Node executor logs now appear in browser devtools in a sidecar-like format, matching the intended debugging experience more closely.

### 11) Hosted browser-console diagnostics became too noisy during normal use

- **Status**: done
- **Symptom**:
  - The browser console showed many hosted diagnostics such as `[HOSTED-DEBUG] ...`, `[HOSTED-OVERRIDE] ...`, `[executor-ws] ...`, and `[tryRunGraph] ...`.
  - Several of these were emitted with `console.error(...)`, so they appeared red and looked like actual failures.
- **Fix**:
  - Added `VITE_RIVET_DEBUG_LOGS` and gated hosted wrapper diagnostics behind it.
  - Kept the useful mirrored Node-executor logs visible even when hosted diagnostics are disabled.
- **Result**:
  - Normal browser-console usage is clean by default.
  - Hosted wiring diagnostics can still be re-enabled when needed by setting `VITE_RIVET_DEBUG_LOGS=true` and rebuilding the web app.
