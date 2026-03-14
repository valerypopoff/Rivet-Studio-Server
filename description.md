# Self-hosted Rivet Wrapper

## What this application is

This repository hosts a browser-based, self-hosted distribution of Rivet.

It is not a forked rewrite of Rivet. The core editor and most product behavior still come from the vendored upstream source in `rivet/`. This repository adds the hosted platform layer around that upstream app so it can run correctly in a browser on a trusted self-hosted machine.

In practical terms, the application provides:

- the upstream Rivet editor running in the browser
- hosted file open/save behavior through an API instead of desktop-native access
- a wrapper-owned workflow dashboard for organizing workflow projects
- published workflow serving at the configured published-workflow base path (`RIVET_PUBLISHED_WORKFLOWS_BASE_PATH`, default `/workflows`, trailing slash tolerated)
- latest working-version workflow serving at the configured latest-workflow base path (`RIVET_LATEST_WORKFLOWS_BASE_PATH`, default `/workflows-latest`, trailing slash tolerated) for published projects
- optional remote debugging for latest workflow endpoint runs over the browser-facing websocket URL `ws://host:port/ws/latest-debugger`
- the same workflow endpoint env var pair shared across frontend, backend, and nginx proxy routing
- optional shared-key protection for public workflow execution plus a separate optional browser/UI gate, both driven by env vars
- Dockerized backend, proxy, and executor services
- a runtime library manager for installing npm packages available to Code nodes across both execution paths
- browser-compatible replacements for desktop-only integrations

The intended result is: **upstream Rivet as the app core, wrapper-owned code as the hosted integration layer**.

## Primary goal

The purpose of this repository is to make Rivet usable through the browser without taking ownership of large, long-lived custom changes inside the upstream codebase.

That goal has several consequences:

- `rivet/` should remain vendor-style and replaceable
- hosted-specific behavior should live in `wrapper/`, `ops/`, and repo-level scripts/docs
- desktop assumptions should be redirected through browser shims, overrides, backend APIs, and container wiring
- the hosted experience should stay as close as practical to the upstream editor instead of becoming a separate product

## High-level architecture

The application is composed of four runtime services:

### `web`

Builds and serves the browser-facing frontend.

This is a wrapper-controlled Vite application that loads and renders the upstream Rivet app, plus wrapper-owned hosted UI such as the workflow dashboard shell.

### `api`

Provides hosted compatibility endpoints.

This replaces desktop-native capabilities with server-side operations exposed over HTTP, including file access, workflow library management, runtime library management, published and latest workflow execution, latest-workflow remote debugger websocket hosting, and related hosted integrations.

### `executor`

Runs the Node-side Rivet executor and debugger service.

This provides hosted Node execution mode and websocket-based debugging/event streaming.

### `proxy`

nginx entrypoint for the full stack.

It routes:

- browser requests to the web app
- `/api/*` traffic to the compatibility backend
- requests under `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH` (default `/workflows`) to last-published workflow execution endpoints
- requests under `RIVET_LATEST_WORKFLOWS_BASE_PATH` (default `/workflows-latest`) to latest working-version workflow execution endpoints for published workflows
- browser editor/admin traffic on `/`, `/api/*`, and `/ws/executor*`, with an optional UI gate at the nginx layer
- websocket traffic to the executor/debugger service
- browser-facing latest-workflow remote debugger traffic on `/ws/latest-debugger`, proxied to the API service

## Repository layout

### `rivet/`

Vendored upstream Rivet source.

This should be treated as vendor code. Wrapper-owned hosted behavior should generally not be implemented directly here.

### `wrapper/web/`

Hosted frontend layer.

This area owns:

- the browser entrypoint
- Vite configuration
- hosted shims and overrides
- the workflow dashboard shell
- iframe/editor bridge logic
- hosted environment wiring

### `wrapper/api/`

Hosted compatibility backend.

This area owns:

- file operations
- project loading and saving
- workflow library filesystem management
- published workflow snapshot storage and execution routing
- latest working-version workflow execution routing for published workflows
- plugin and shell-related hosted endpoints
- runtime library management (install, remove, validation, staged promotion)
- allowed environment/config exposure

The wrapper API also carries most wrapper regression coverage under `wrapper/api/src/tests/`.

### `wrapper/shared/`

Shared wrapper-owned contracts, typed bridge messages, and environment helpers.

This area owns:

- hosted environment derivation
- shared workflow-related types
- the typed editor/dashboard bridge contract in `wrapper/shared/editor-bridge.ts`

### `ops/`

Runtime and deployment wiring.

This includes:

- Dockerfiles
- Docker Compose files
- nginx configuration
- executor bundling/patching
- deployment-oriented operational assets

### `scripts/`

Developer helpers for local and Docker-based workflows.

Current notable behavior:

- root `npm run dev` uses `scripts/dev-docker.mjs`
- the launcher reads repo-root `.env.dev`
- it resolves `RIVET_WORKFLOWS_HOST_PATH` before invoking Docker Compose so workflow-library host paths are stable and predictable

### `findings-and-problems.md`

Working engineering handoff document for discovered issues, constraints, and in-progress findings.

## Frontend model

The hosted frontend boots the upstream Rivet app through wrapper-owned infrastructure.

Key points:

- `wrapper/web/entry.tsx` provides browser-safe global shims before loading the app
- `wrapper/web/vite.config.ts` controls aliases, overrides, dev-server behavior, and hosted build wiring
- wrapper-owned overrides replace desktop-oriented upstream modules where simple shims are not enough
- hosted runtime values such as API and websocket URLs are derived from browser location in `wrapper/shared/hosted-env.ts`

The important architectural idea is that the wrapper changes the **platform layer**, not the editor's core product identity.

## Backend model

The backend exists to replace Tauri/local-native behavior with API-backed hosted behavior.

Typical responsibilities include:

- reading and writing project files on the server
- listing files and directories inside allowed roots
- managing the dedicated workflow library under the host-backed `workflows/` directory
- serving published workflows from stable snapshot files under the configured published-workflow base path
- serving trusted internal published-workflow calls on `/internal/workflows/:endpointName` without bearer auth
- serving the latest working version of published workflows under the configured latest-workflow base path
- enforcing `Authorization: Bearer <RIVET_KEY>` on both external published and latest workflow execution endpoints when `RIVET_REQUIRE_WORKFLOW_KEY=true`
- validating that `/api/*`, `/ui-auth`, and the latest-workflow debugger websocket are reached through the trusted nginx proxy path rather than directly
- hosting a websocket remote debugger endpoint for latest workflow executions only
- loading referenced projects
- running allowlisted shell commands
- managing plugin installation/loading
- exposing controlled environment/config values to the hosted frontend

The browser talks to this service through wrapper shims and overrides instead of talking directly to the user's machine.

### Workflow project metadata model

Workflow projects in the dashboard are not just raw `.rivet-project` files.

For each project, the wrapper may also manage nearby sidecar files:

- `.rivet-data` for project data that belongs with the workflow file
- `.wrapper-settings.json` for wrapper-owned project settings metadata

That wrapper settings sidecar currently stores hosted dashboard metadata such as:

- the endpoint name used for publication, preserving the casing the user entered
- the currently published endpoint name that remains live until the next publish or unpublish, also preserving the entered casing
- the published snapshot identifier for the last live version
- the last published state hash used to derive publish status

The settings sidecar is wrapper-owned infrastructure, not upstream Rivet product data.

When a workflow project is moved through the dashboard, the wrapper moves the related sidecars with it so the project's hosted metadata follows the file.

Published workflow snapshots themselves are stored separately under the workflow root's hidden `.published/` directory so the live served version can remain stable even while the working project file has unpublished changes.

The two public execution paths intentionally serve different targets:

- `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH/[endpoint-name]` (default `/workflows/[endpoint-name]`) serves the last published snapshot
- `RIVET_LATEST_WORKFLOWS_BASE_PATH/[endpoint-name]` (default `/workflows-latest/[endpoint-name]`) serves the current working project file for workflows that are published or have unpublished changes
- both public execution paths enforce `Authorization: Bearer <RIVET_KEY>` when `RIVET_REQUIRE_WORKFLOW_KEY=true` and `RIVET_KEY` is non-empty, except for requests that nginx has already marked as coming from a configured token-free host in `RIVET_UI_TOKEN_FREE_HOSTS`

There is also an API-container-only internal published-workflow route:

- `/internal/workflows/[endpoint-name]` serves the same published snapshot as `/workflows/[endpoint-name]`
- it is mounted directly on the API service and is not exposed through nginx
- it intentionally skips `RIVET_KEY` bearer-token enforcement and is meant only for trusted intra-stack callers such as other containers on the same Docker network
- because the API service listens on port 80 inside the Docker network, trusted intra-stack callers can use hostnames like `http://api/internal/workflows/[endpoint-name]` without specifying a port

The nginx layer can independently gate browser access to the editor/admin surface:

- `RIVET_REQUIRE_UI_GATE_KEY=true` turns on the UI token gate
- `RIVET_UI_TOKEN_FREE_HOSTS` is a comma-separated list of hostnames that bypass that gate when it is enabled
- those same hosts also bypass bearer-token auth on the public `/workflows/*` and `/workflows-latest/*` execution routes, but only because nginx forwards an explicit trusted header to the API for those requests
- all other hosts are shown a browser-side key prompt on `/` when the gate is enabled
- that prompt is served from `ops/ui-gate-prompt.html` and submits a normal HTML form to `POST /__rivet_auth`
- the prompt includes a hidden `username=Rivet` field so browser password managers can store the credential more reliably without showing a username input in the UI
- after successful key entry, the browser posts the key to a proxy-backed auth endpoint and receives a derived HTTP-only session cookie so `/api/*`, `/ws/executor*`, and `/ws/latest-debugger` continue to work for that browser session without exposing `RIVET_KEY` in the URL or cookie value
- the prompt and auth responses are marked `no-store` / `no-cache` so browsers do not cache the login page or auth response
- this nginx UI gate does not replace workflow execution route auth; those routes are still controlled by the API bearer-token check described above
- the API also independently rejects direct `/api/*`, `/ui-auth`, and `/ws/latest-debugger` requests that do not carry the trusted proxy header injected by nginx

Remote debugging is intentionally scoped only to the latest-workflow execution path:

- the browser-facing remote debugger websocket URL is `ws://host:port/ws/latest-debugger`
- runs triggered through `RIVET_LATEST_WORKFLOWS_BASE_PATH` attach to that debugger server
- runs triggered through `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH` remain debugger-free
- the debugger server is only started when `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER=true`
- `GET /api/config` only advertises a default remote debugger websocket URL when the feature is enabled

Current hosted-editor wiring detail:

- the hosted Remote Debugger connect panel currently seeds its default URL from `wrapper/shared/hosted-env.ts`, which resolves to `/ws/latest-debugger` from the current browser origin
- the hosted editor does not currently source its initial debugger URL from `GET /api/config`
- the default debugger URL no longer needs a separate debugger-specific token

Latest-workflow remote debugger security and connection model:

- the feature is disabled by default and should only be enabled intentionally
- enabling it requires `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER=true`
- the feature is intentionally scoped only to the latest-workflow execution path
- the browser-facing remote debugger websocket URL is `ws://host:port/ws/latest-debugger`
- runs triggered through `RIVET_LATEST_WORKFLOWS_BASE_PATH` attach to that debugger server
- runs triggered through `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH` remain debugger-free
- the debugger server is only started when `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER=true`
- `/api/config` only advertises a default remote debugger websocket URL when the feature is enabled
- the hosted debugger connect UI defaults to `/ws/latest-debugger` from browser origin
- access to that websocket now follows the same nginx UI gate as the editor surface, including `RIVET_UI_TOKEN_FREE_HOSTS`
- the API-side websocket upgrade handler also requires the trusted proxy header, so direct host-level access to the API websocket endpoint is not considered a valid external access path

Typical user-facing connection examples:

- local HTTP: `ws://localhost:8080/ws/latest-debugger`
- hosted HTTPS: `wss://your-host/ws/latest-debugger`

Operationally, this means:

- published workflow endpoint execution remains stable and debugger-free
- latest workflow endpoint execution can be remotely debugged only when the feature flag is on
- access to the debugger websocket is controlled by the same nginx UI gate as the editor surface

Fully unpublished projects are not served by either public execution path.

### Dashboard layout and behavior

- the left panel is wrapper-owned UI from `wrapper/web/dashboard/`
- the main editor area remains the upstream Rivet editor
- the left `Projects` pane can be resized by dragging its right edge
- the `Projects` pane can be collapsed from the header
- when the pane is collapsed, a restore button is shown in the bottom-left corner of the window
- when zero editor project tabs are open, the wrapper forces the `Projects` pane open even if the user had previously collapsed it
- when zero editor project tabs are open, the dashboard hides the embedded editor surface and shows a wrapper-owned empty state instead of Rivet's default start screen

### Editor/dashboard coordination

The dashboard and the embedded editor are deliberately split into two cooperating layers:

- the dashboard owns wrapper UI, workflow browsing, popup state, and high-level file-management actions
- the embedded editor owns actual Rivet project editing and tab state
- the two sides coordinate through the shared typed message contract in `wrapper/shared/editor-bridge.ts`, implemented by `DashboardPage.tsx` and `EditorMessageBridge.tsx`

Bridge behavior is intentionally defensive:

- both sides validate inbound messages by shape before acting on them
- the bridge only accepts messages from the expected window/origin/source combination
- outbound messages target the current browser origin instead of wildcard `*`

That message bridge is responsible for wrapper-specific coordination such as:

- opening workflow projects in the editor
- saving the active workflow project
- updating tracked file paths when workflow items are moved
- removing deleted projects from the editor's open-tab state
- notifying the dashboard when a project save has completed so wrapper-derived status can refresh

### Workflow library contents

- folders and `.rivet-project` files are loaded from `/api/workflows/tree`
- projects may exist directly at the workflow root or inside folders
- nested workflow folders are supported
- the pane exposes a root-level `+ New folder` action at the bottom of the tree area
- nested folders can then be formed by dragging folders into other folders
- new workflow projects are created from the `+` action on each folder row
- workflow list, create, rename, publish, unpublish, delete, and move operations are routed from `wrapper/api/src/routes/workflows/index.ts`
- the actual workflow logic is split across `workflow-query.ts`, `workflow-mutations.ts`, `publication.ts`, `execution.ts`, and shared helpers in `fs-helpers.ts`
- dot-prefixed names and relative path segments are rejected so wrapper-internal paths such as `.published` never appear as user workflow items

### Folder and project interactions

- clicking anywhere on a folder row except the folder action area toggles expand/collapse
- the left chevron is only a visual expanded/collapsed indicator; it is not a separate button
- folder rows support keyboard expand/collapse with `Enter` and `Space`
- double-clicking the folder name triggers rename from the tree row
- single-clicking a project row selects it in the pane without opening it in the editor
- double-clicking a project row opens it in the editor and normally activates or adds an editor tab instead of replacing the current tab
- project rename and move operations carry `.rivet-data` and `.wrapper-settings.json` sidecars with the project instead of leaving metadata behind
- project rename and move operations reject conflicting sidecar targets before mutating disk, so half-moved project state is avoided

### Active project visibility

- when the selected workflow project is inside a collapsed workflow folder, the pane automatically expands all ancestor folders necessary to expose the selected item
- when the selected workflow project changes, the pane automatically scrolls the highlighted project row into view

### Active project section

The dashboard shows a pinned wrapper-owned `Active project` section near the top of the `Projects` pane.

Current behavior:

- the section follows the currently selected workflow project in the pane
- when there is no separate selected project, the currently opened workflow project becomes the displayed project
- when there is no selected or opened workflow project, the section stays visible and shows an empty placeholder inviting the user to select a project
- it shows the current publish-related status badge inline with the project name
- it shows the project basename without the `.rivet-project` extension
- it shows derived project stats as `N graphs, M nodes total`
- its primary action is `Save` when the displayed project is currently open in the editor
- it shows `Edit` instead when the displayed project is selected but not currently open in the editor
- it contains a `Settings` action that opens the project settings popup

This section is meant to stay visible independently of the scroll position of the workflow tree so the user always has access to the selected project's main actions.

### Save behavior

- the wrapper-owned `Save` button in the `Projects` pane is driven by the editor's active tab rather than stale last-loaded state
- when the active editor tab is a file-backed workflow project, the wrapper `Save` action saves that exact file path
- hosted `Save As` reuses the current file-backed workflow project's directory as the default suggestion when available, so projects opened from nested workflow folders do not get flattened back to the workflow root by default
- `Ctrl+S` / `Cmd+S` handling is split by focus context
- in the top-level dashboard page, the wrapper handles the shortcut only when focus is outside the editor iframe and only when there is an active file-backed workflow project
- inside the editor iframe, `EditorMessageBridge.tsx` suppresses the browser default; on Windows it relies on upstream Rivet's existing save hotkey handling, while on non-Windows it performs the hosted save directly
- after any successful save path, the embedded editor notifies the dashboard so the workflow pane can immediately refresh derived publish state for the active project

### Project settings popup

The `Settings` action for the selected project opens a wrapper-owned project settings popup.

Current popup behavior:

- the header shows the project basename without the file extension
- the header includes an inline pencil action for rename
- rename uses an in-place title editor instead of replacing the header with a separate form block
- the current publish-related status badge and explanation appear in the modal body, not under the header title
- the published/unpublished help text interpolates the actual endpoint path instead of showing a placeholder
- the endpoint field preserves the exact casing the user entered instead of forcing lowercase for display or storage
- the popup can be closed with the close button or by clicking outside it when no rename/save/delete operation is in progress
- close/dismiss is the cancel behavior; there is no separate cancel button
- the popup is designed to stay open after publish, unpublish, publish-changes, and rename actions so the user can continue reviewing the project state
- the popup includes project deletion with confirmation, but the delete action is currently exposed in the UI only while the project is `unpublished` and the publish-settings editor is not expanded

### Project rename behavior

- rename is initiated from the project settings header, not from the tree row itself
- the rename validator rejects empty names, path separators, and invalid filesystem characters
- duplicate-name validation is scoped to the same folder and is case-insensitive
- case-only renames are supported on case-insensitive filesystems such as Windows
- renaming a project also renames its wrapper-managed sidecar files and notifies the editor/dashboard path-tracking layer

### Publish model in project settings

The project settings popup does not let the user manually choose a status. Instead, the status is derived from wrapper-owned publication metadata.

Current status values are:

- `unpublished`
- `published`
- `unpublished_changes`

The practical rules are:

- a newly created project starts as `unpublished`
- `Publish` requires an endpoint name
- the endpoint name must be URL-path compatible and unique among workflow projects
- endpoint names preserve the user's entered casing for storage and display
- endpoint uniqueness and incoming endpoint request matching remain case-insensitive, so names that differ only by letter case still conflict
- publishing stores a published-state hash based on the endpoint name and the current project file contents
- if the project remains unchanged since publication, the status is `published`
- if the project file changes after publication and is saved, the status becomes `unpublished_changes`
- `Publish changes` updates the stored published-state hash to the current endpoint-plus-file state
- `Unpublish` clears the stored published-state hash and returns the project to `unpublished`
- the settings UI is status-specific rather than always showing the endpoint editor
- for `unpublished`, the modal first shows `Publish...`; clicking it reveals the endpoint-path editor and the inline `Publish` button
- for `published`, the modal shows only `Unpublish`
- for `unpublished_changes`, the modal shows `Publish changes` followed by `Unpublish`

### Endpoint editing rules

Endpoint editing is intentionally tied to publication state.

Current behavior:

- the endpoint field is hidden by default and becomes visible only after the user clicks `Publish...` for an unpublished project
- the endpoint field is editable only while the project is `unpublished`
- once the project is `published` or has `unpublished_changes`, the endpoint field is locked
- to change the endpoint, the user must unpublish first, edit the endpoint, and then publish again
- there is no separate `Save endpoint` action; the endpoint is committed through publishing

### Delete behavior

Deleting a workflow project from the project settings popup is a wrapper-managed workflow action, not just a raw file delete.

Current behavior:

- the delete action is only shown in the UI while the project is currently `unpublished`
- the delete action is hidden while the unpublished project's publish-settings editor is expanded
- the user must confirm deletion
- regardless of current publication state, the backend delete route removes any published snapshot before deleting the project file
- the project file is deleted from the workflow library
- the `.rivet-data` sidecar is also deleted if it exists
- the `.wrapper-settings.json` sidecar is also deleted if it exists
- the dashboard tells the editor bridge to close or switch away from the deleted project as needed

### Drag and drop behavior

- workflow projects can be dragged into folders, between folders, and back to the root
- workflow folders can be dragged into other folders and back to the root
- folder moves are real filesystem moves, not UI-only reorder operations
- dragging a folder into another folder creates the same nested structure on disk
- when a project has an associated `.rivet-data` sidecar, it moves with the project file
- when an already-open workflow project is moved through the pane, the dashboard updates the editor's tracked file path so later `Save` / `Ctrl+S` / `Cmd+S` actions still write to the new location without reopening the project

### Success and error feedback

- routine workflow-pane actions stay quiet on success
- toast notifications are used for actual failures

## Workflow library root

The workflow dashboard is backed by a dedicated filesystem root configured through:

- `RIVET_WORKFLOWS_ROOT`
- host-side Docker bind configuration via `RIVET_WORKFLOWS_HOST_PATH`

Current runtime expectations:

- Docker Compose mounts a host-backed `workflows/` directory into the API container at `/workflows`
- when using root `npm run dev`, `RIVET_WORKFLOWS_HOST_PATH` and the published/latest workflow endpoint base path vars are read from the repo-root `.env.dev`
- the frontend reads the workflow endpoint base path vars directly as `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH` and `RIVET_LATEST_WORKFLOWS_BASE_PATH` instead of using a separate `VITE_...` workflow-path variable pair
- published/latest workflow endpoint base path values are normalized before use, so both `/workflows` and `/workflows/` resolve to the same route prefix
- when `RIVET_REQUIRE_WORKFLOW_KEY=true` and `RIVET_KEY` is set, both public workflow execution route families require a matching bearer token unless nginx has marked the request as coming from a host listed in `RIVET_UI_TOKEN_FREE_HOSTS`, while `/internal/workflows/[endpoint-name]` remains exempt
- when `RIVET_REQUIRE_UI_GATE_KEY=true`, nginx allows browser editor/admin access without an auth prompt only on the hosts listed in `RIVET_UI_TOKEN_FREE_HOSTS`
- for all other hosts, `GET /` serves the browser-side key prompt and `POST /__rivet_auth` exchanges the entered key for a derived HTTP-only session cookie
- production traffic is expected to reach the API through nginx rather than a host-published API port; direct production API host exposure is no longer part of the intended external access model
- hosted websocket defaults are derived from the browser origin in `wrapper/shared/hosted-env.ts`, with `/ws/executor/internal` for the executor and `/ws/latest-debugger` as the latest-workflow debugger default
- in the dev Docker stack, the API service loads `.env.dev` via `env_file`, so `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER` is available there when defined
- in the current production `ops/docker-compose.yml`, `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER` is forwarded into the API container so the latest debugger can be enabled there without extra compose changes
- the API service listens on port 80 inside the Docker network; production no longer publishes that port to the host, while the dev stack still maps the host-facing API port from `RIVET_API_PORT` (default `3100`) to that internal port for local development
- API security allows workflow-library operations only inside that validated workflow root
- hosted `Save As` falls back to `/workflows/...` for unsaved projects, but for already file-backed workflow projects it suggests the current project directory so nested workflow locations are preserved by default

Example supported setup:

- `RIVET_WORKFLOWS_HOST_PATH=../workflows`

This allows the workflow library to live outside the git repository so generated workflow assets do not need to be tracked in repo history.

This workflow root is intentionally narrower than the broader workspace root so the dashboard can manage authored workflows without turning into unrestricted filesystem browsing.

## Host-side workflow consumer model

The workflow dashboard is designed so a separate host-side service can consume the same persisted workflow directory.

Recommended model:

- the dashboard creates and edits `.rivet-project` files under the host-backed workflow root
- a separate host-side service watches or scans that same directory
- that service treats the on-disk workflow files as the source of truth for publication/runtime exposure
- the wrapper should remain an authoring and organization layer, not the orchestration/deployment service for published workflows

This separation keeps the browser wrapper focused on editing and organization while allowing a dedicated host process to own exposure/runtime concerns.

## Executor model

Hosted Node execution is provided by the separate executor service instead of a local desktop sidecar.

Current model:

- the browser connects to the executor/debugger over websocket
- Node-mode runs are sent to the executor service
- processor and debugger events are streamed back to the browser
- `wrapper/web/overrides/hooks/useGraphExecutor.ts` stays close to upstream and mainly owns hosted executor selection plus the hosted websocket endpoint
- websocket lifecycle is handled by `wrapper/web/overrides/hooks/useRemoteDebugger.ts`
- the hosted Docker executor bundle is patched in `ops/bundle-executor.cjs` for deployment-specific behavior

This executor websocket path is separate from latest workflow endpoint remote debugging:

- editor Node-mode execution continues to use the executor websocket service
- latest workflow endpoint remote debugging uses the API-hosted websocket endpoint `ws://host:port/ws/latest-debugger`
- when enabled, latest workflow endpoint remote debugging uses the same nginx UI gate as the editor surface
- published workflow endpoint execution does not attach any remote debugger

This separation is important:

- the executor websocket remains the channel for editor-driven Node execution mode
- the latest-workflow debugger websocket exists specifically so browser-reachable workflow endpoint runs can stream debugger events from the API process
- securing the latest-workflow debugger therefore happens at the nginx UI gate rather than inside the executor service

That executor patching is used for hosted concerns such as:

- Docker-friendly binding behavior
- forwarding relevant executor traces to the browser
- surfacing Node Code-node console output in browser devtools as hosted logs
- dynamic runtime-library resolution so Code nodes can require hot-installed packages without restarting the executor
- failing fast if an upstream executor snippet changes in a way that would silently break the hosted patch

## Runtime library manager

Code nodes in Rivet can `require()` external npm packages when `allowRequire` is enabled. In a desktop environment that resolves from the local machine, but in the hosted wrapper there is no user-accessible filesystem for ad-hoc npm installs.

The runtime library manager is a wrapper-owned feature that lets users install and remove npm packages from the browser UI so those packages become available to Code nodes in both execution paths without restarting containers or rebuilding images.

### UI

The feature is accessed through the `Runtime libraries` button at the bottom of the `Projects` pane in `WorkflowLibraryPanel.tsx`. Clicking it opens a modal (`RuntimeLibrariesModal.tsx`) that shows:

- the list of currently installed runtime libraries with package name, version, and a remove action
- an `Add library...` action that reveals the install form with package name and version fields
- an install button that starts a background job
- a live log panel that streams npm install output in real time via Server-Sent Events
- a final success or failure verdict when the job completes
- if the modal is reopened while a job is still running, it reconnects to that in-progress job and resumes the streamed log view

Controls are disabled while a job is running. Feedback stays inside the modal rather than producing global toasts.

### API

Runtime library management is served by `wrapper/api/src/routes/runtime-libraries.ts` under `/api/runtime-libraries`:

- `GET /` returns the current manifest-derived state (`packages`, `hasActiveLibraries`, `updatedAt`, and `activeJob`)
- `POST /install` starts a background install job (returns 202)
- `POST /remove` starts a background removal job (returns 202)
- `GET /jobs/:jobId` returns job state
- `GET /jobs/:jobId/stream` provides SSE log streaming with `X-Accel-Buffering: no` for nginx compatibility

Only one mutating job runs at a time. Concurrent requests receive a 409 Conflict response.

### Runtime library activation model

Runtime libraries are managed under `RIVET_RUNTIME_LIBRARIES_ROOT` (default `/data/runtime-libraries`):

```
<root>/
  manifest.json
  current/
    package.json
    node_modules/
  staging/
```

The install/remove flow:

1. read current manifest and build a candidate dependency set
2. create a fresh staging directory with a generated `package.json`
3. run `npm install --production` with streamed output
4. validate the candidate using `createRequire()` and `require.resolve()` for each package
5. swap `staging/` into `current/`, keeping a restorable backup during activation
6. update `manifest.json`

A failed install never replaces the active `current/` set. The staging directory is cleaned up on failure. If activation fails mid-swap, the previous `current/` directory is restored and both execution paths continue working.

### Shared runtime resolution

Both execution paths resolve packages from the same active `current/` set:

- **Published endpoints (API container)**: `executeWorkflowEndpoint()` passes a `ManagedCodeRunner` instance to `runGraph()` via the existing `codeRunner` option. On each `runCode()` call, `ManagedCodeRunner` resolves `current/node_modules` and creates a `require` function rooted there. Falls back to standard `NODE_PATH` resolution when no managed runtime-library set exists.

- **Editor execution (executor container)**: The `bundle-executor.cjs` build-time patch replaces `NodeCodeRunner`'s `createRequire` call with dynamic resolution that resolves `current/node_modules` on every Code node invocation. Falls back to the original executor bundle resolution when no managed runtime-library set exists.

Both paths resolve the active runtime-library location per invocation. Because `createRequire()` is called fresh each time, newly activated libraries take effect immediately without process restarts.

### Persistence

Runtime library state lives in a dedicated Docker named volume (`rivet_runtime_libs`) mounted at `/data/runtime-libraries` in both the API and executor containers. The `RIVET_RUNTIME_LIBRARIES_ROOT` environment variable is the single source of truth for the path.

Installed libraries survive container restarts and image rebuilds. On startup, the API runs a reconciliation step that validates `current/node_modules` exists when the manifest lists packages, clears stale manifest state when the active runtime-library set is missing, and migrates the older `active-release` plus `releases/NNNN/` layout into `current/` when present. Manifest reads are normalized defensively so malformed or stale JSON does not leave the runtime-library state half-valid in memory.

In dev mode, `scripts/dev.mjs` sets `RIVET_RUNTIME_LIBRARIES_ROOT` to `.data/runtime-libraries` under the repo root.

### Fallback behavior

When no managed runtime libraries are installed (no valid `current/node_modules` exists), both execution paths continue working using image-baked dependencies via `NODE_PATH`. This ensures backward compatibility with existing setups where `wrapper/executor/package.json` dependencies (such as `sharp`) are installed at Docker build time.

### Implementation files

- `wrapper/api/src/runtime-libraries/manifest.ts` - manifest read/write, normalization, and `current/` / `staging/` path helpers
- `wrapper/api/src/runtime-libraries/job-runner.ts` - staging, npm install, validation, promotion
- `wrapper/api/src/runtime-libraries/managed-code-runner.ts` - `ManagedCodeRunner` implementing the `CodeRunner` interface
- `wrapper/api/src/utils/exec.ts` - shared `child_process.spawn` helpers for non-streaming and streaming process execution
- `wrapper/api/src/runtime-libraries/startup.ts` - startup reconciliation and old release cleanup
- `wrapper/api/src/routes/runtime-libraries.ts` - API route handler
- `wrapper/web/dashboard/RuntimeLibrariesModal.tsx` - modal component
- `wrapper/web/dashboard/RuntimeLibrariesModal.css` - modal styles
- `wrapper/web/dashboard/runtimeLibrariesApi.ts` - client API helper
- `ops/bundle-executor.cjs` - executor-side dynamic require patch

## Design rules

### Vendor boundary

Do not put wrapper-owned hosted behavior directly inside `rivet/` unless there is a compelling reason and no practical wrapper-level alternative.

Default location for hosted changes:

- `wrapper/`
- `ops/`
- repo-level scripts and docs

### Wrapper-first integration strategy

If upstream desktop behavior depends on Tauri, local sidecars, or direct filesystem access, the hosted implementation should prefer:

- a shim
- an override
- a backend API
- service/container wiring

and should avoid permanently forking upstream behavior where possible.

## Regression-sensitive feature checklist

The following statements should remain true after major refactors unless there is an intentional product change:

- the app still opens as a hosted wrapper around the upstream Rivet editor rather than as a separate forked UI
- the editor still runs in the main dashboard area and remains functionally upstream Rivet
- the workflow dashboard still owns project organization, not the core editor
- file-backed workflow projects still save to their real on-disk paths through the hosted API
- `Ctrl+S` / `Cmd+S` still save the active file-backed workflow project correctly, with dashboard-level handling outside the iframe and iframe-specific handling inside it
- the active project in the `Projects` pane is still computed as `selectedProjectPath || openedProjectPath`
- the active project row is still highlighted in the `Projects` pane
- collapsed parent folders of the active project still auto-expand so the active item is visible
- the pane still scrolls the active project row into view when needed
- workflow folders and projects are still creatable from the dashboard
- workflow folders and projects are still movable on disk through drag and drop
- moving an already-open project still preserves later save behavior without forcing a reopen
- project settings metadata still follows workflow moves because the wrapper moves the related settings sidecar together with the project
- the workflow library is still constrained to the validated workflow root
- the app still uses API-backed and websocket-backed hosted services instead of assuming desktop-native integrations
- the active project section and project settings popup still reflect the active workflow project, defaulting to the opened workflow project when nothing else is selected
- the active project section still shows the status badge inline with the project basename and still offers `Save`/`Edit` plus `Settings`
- the project settings popup still uses a basename-only header title with inline rename control
- unpublished projects still expose `Publish...` before revealing endpoint editing, while published states still use status-specific action buttons
- the project settings delete action is still only visible for unpublished projects and stays hidden while publish settings are being edited
- published and unpublished-changes help text still show the real configured published/latest workflow endpoint paths
- published endpoint names still preserve the user's entered casing in the settings UI while endpoint matching remains case-insensitive
- trusted intra-stack callers can still invoke published workflows through `/internal/workflows/[endpoint-name]` on the API service without bearer auth, while the external published route remains separately configurable
- trusted intra-stack callers can continue to use the portless Docker-network URL form `http://api/internal/workflows/[endpoint-name]`
- latest workflow endpoint debugging still remains opt-in and latest-only when enabled
- `GET /api/config` still suppresses the default latest debugger websocket URL when the secured debugger feature is disabled
- the hosted debugger connect UI still defaults to `/ws/latest-debugger` from browser origin
- `RIVET_UI_TOKEN_FREE_HOSTS` still bypasses the editor and latest-debugger websocket gate for listed internal hosts
- the editor/dashboard bridge still uses a shared typed contract and origin/source validation instead of trusting arbitrary `postMessage` payloads
- runtime libraries installed through the manager are available to Code nodes in both editor runs and published endpoint calls without restarting containers
- a failed runtime library install does not break the currently active release or disrupt running workflows
- reopening the runtime libraries modal during an active install/remove job still reconnects to the same job stream and shows its current logs/status
- the runtime library trigger button appears at the bottom of the `Projects` pane when the pane is open
- the `+ New folder` action remains below the workflow tree rather than above it

## Current practical outcome

This repository produces a maintainable, self-hosted browser deployment of Rivet with a clear separation between:

- upstream vendor code
- wrapper-owned hosted integrations
- runtime/deployment infrastructure

The resulting app is not just the raw upstream editor in a browser tab. It is a hosted Rivet distribution with a wrapper-owned workflow-management layer around the upstream editor, while still trying to preserve upstream behavior wherever practical.
