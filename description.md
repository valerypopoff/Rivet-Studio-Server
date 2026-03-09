# Self-hosted Rivet Wrapper

## What this application is

This repository hosts a browser-based, self-hosted distribution of Rivet.

It is not a forked rewrite of Rivet. The core editor and most product behavior still come from the vendored upstream source in `rivet/`. This repository adds the hosted platform layer around that upstream app so it can run correctly in a browser on a trusted self-hosted machine.

In practical terms, the application provides:

- the upstream Rivet editor running in the browser
- hosted file open/save behavior through an API instead of desktop-native access
- a wrapper-owned workflow dashboard for organizing workflow projects
- published workflow serving at `/workflows/[endpoint-name]`
- latest working-version workflow serving at `/workflows-last/[endpoint-name]` for published projects
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

This replaces desktop-native capabilities with server-side operations exposed over HTTP, including file access, workflow library management, runtime library management, published and latest workflow execution, and related hosted integrations.

### `executor`

Runs the Node-side Rivet executor and debugger service.

This provides hosted Node execution mode and websocket-based debugging/event streaming.

### `proxy`

nginx entrypoint for the full stack.

It routes:

- browser requests to the web app
- `/api/*` traffic to the compatibility backend
- `/workflows/*` traffic to last-published workflow execution endpoints
- `/workflows-last/*` traffic to latest working-version workflow execution endpoints for published workflows
- websocket traffic to the executor/debugger service

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

### `wrapper/shared/`

Shared wrapper-owned contracts and environment helpers.

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
- serving published workflows from stable snapshot files under `/workflows/[endpoint-name]`
- serving the latest working version of published workflows under `/workflows-last/[endpoint-name]`
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

- the endpoint name used for publication
- the currently published endpoint name that remains live until the next publish or unpublish
- the published snapshot identifier for the last live version
- the last published state hash used to derive publish status

The settings sidecar is wrapper-owned infrastructure, not upstream Rivet product data.

When a workflow project is moved through the dashboard, the wrapper moves the related sidecars with it so the project's hosted metadata follows the file.

Published workflow snapshots themselves are stored separately under the workflow root's hidden `.published/` directory so the live served version can remain stable even while the working project file has unpublished changes.

The two public execution paths intentionally serve different targets:

- `/workflows/[endpoint-name]` serves the last published snapshot
- `/workflows-last/[endpoint-name]` serves the current working project file for workflows that are published or have unpublished changes

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
- the two sides coordinate through `postMessage` in `DashboardPage.tsx` and `EditorMessageBridge.tsx`

That message bridge is responsible for wrapper-specific coordination such as:

- opening workflow projects in the editor
- saving the active workflow project
- updating tracked file paths when workflow items are moved
- removing deleted projects from the editor's open-tab state
- notifying the dashboard when a project save has completed so wrapper-derived status can refresh

### Workflow library contents

- folders and `.rivet-project` files are loaded from `/api/workflows/*`
- projects may exist directly at the workflow root or inside folders
- nested workflow folders are supported
- the pane exposes a `+ New folder` action
- the pane supports creating `.rivet-project` files inside folders
- workflow create, rename, list, and move operations are implemented by `wrapper/api/src/routes/workflows.ts`

### Folder and project interactions

- folder expand/collapse is limited to the left chevron hit area
- double-clicking the folder name area triggers rename without also toggling folder expansion
- single-clicking a project row selects it in the pane without opening it in the editor
- double-clicking a project row opens it in the editor and normally activates or adds an editor tab instead of replacing the current tab

### Active project visibility

- when the selected workflow project is inside a collapsed workflow folder, the pane automatically expands all ancestor folders necessary to expose the selected item
- when the selected workflow project changes, the pane automatically scrolls the highlighted project row into view

### Active project section

The dashboard shows a pinned wrapper-owned `Active project` section near the top of the `Projects` pane.

Current behavior:

- the section follows the currently selected workflow project in the pane
- when there is no separate selected project, the currently opened workflow project becomes the displayed project
- the section is hidden when there is no selected or opened workflow project
- it shows the full project filename including `.rivet-project`
- it shows the current publish-related status directly under the filename
- it contains the wrapper-owned `Save` action when the displayed project is currently open in the editor
- it shows `Edit` instead when the displayed project is selected but not currently open in the editor
- it contains a `More` action that opens the project settings popup

This section is meant to stay visible independently of the scroll position of the workflow tree so the user always has access to the selected project's main actions.

### Save behavior

- the wrapper-owned `Save` button in the `Projects` pane is driven by the editor's active tab rather than stale last-loaded state
- when the active editor tab is a file-backed workflow project, the wrapper `Save` action saves that exact file path
- hosted `Save As` reuses the current file-backed workflow project's directory as the default suggestion when available, so projects opened from nested workflow folders do not get flattened back to the workflow root by default
- the dashboard maps `Ctrl+S` / `Cmd+S` to that same hosted save behavior
- when the active editor is not a path-backed workflow project, or when no tabs are open, the wrapper `Save` button is hidden
- after any successful save path, the embedded editor notifies the dashboard through the same save-completion signal so the workflow pane can immediately refresh derived publish state for the active project

### Project settings popup

The `More` action for the selected project opens a wrapper-owned project settings popup.

Current popup behavior:

- the header shows the full project filename including extension
- the current publish-related status appears directly under the filename
- the popup can be closed with the close button or by clicking outside it
- close/dismiss is the cancel behavior; there is no separate cancel button
- the popup stays open after publish, unpublish, and publish-changes actions so the user can continue reviewing the project state
- the popup includes project deletion with confirmation

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
- publishing stores a published-state hash based on the endpoint name and the current project file contents
- if the project remains unchanged since publication, the status is `published`
- if the project file changes after publication and is saved, the status becomes `unpublished_changes`
- `Publish changes` updates the stored published-state hash to the current endpoint-plus-file state
- `Unpublish` clears the stored published-state hash and returns the project to `unpublished`

### Endpoint editing rules

Endpoint editing is intentionally tied to publication state.

Current behavior:

- the endpoint field is editable only while the project is `unpublished`
- once the project is `published` or has `unpublished_changes`, the endpoint field is locked
- to change the endpoint, the user must unpublish first, edit the endpoint, and then publish again
- there is no separate `Save endpoint` action; the endpoint is committed through publishing

### Delete behavior

Deleting a workflow project from the project settings popup is a wrapper-managed workflow action, not just a raw file delete.

Current behavior:

- the user must confirm deletion
- if the project is published or has unpublished changes, the wrapper first unpublishes it
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
- when using root `npm run dev`, `RIVET_WORKFLOWS_HOST_PATH` from the repo-root `.env.dev` is resolved relative to the repo root before Docker Compose starts
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

The feature is accessed through a trigger button at the bottom of the `Projects` pane in `WorkflowLibraryPanel.tsx`. Clicking it opens a modal (`RuntimeLibrariesModal.tsx`) that shows:

- the list of currently installed runtime libraries with package name, version, and a remove action
- an add form with package name and version fields
- an install button that starts a background job
- a live log panel that streams npm install output in real time via Server-Sent Events
- a final success or failure verdict when the job completes

Controls are disabled while a job is running. Feedback stays inside the modal rather than producing global toasts.

### API

Runtime library management is served by `wrapper/api/src/routes/runtime-libraries.ts` under `/api/runtime-libraries`:

- `GET /` returns the current manifest (installed packages, active release, active job)
- `POST /install` starts a background install job (returns 202)
- `POST /remove` starts a background removal job (returns 202)
- `GET /jobs/:jobId` returns job state
- `GET /jobs/:jobId/stream` provides SSE log streaming with `X-Accel-Buffering: no` for nginx compatibility

Only one mutating job runs at a time. Concurrent requests receive a 409 Conflict response.

### Versioned release model

Runtime libraries are managed through a versioned release system under `RIVET_RUNTIME_LIBRARIES_ROOT` (default `/data/runtime-libraries`):

```
<root>/
  manifest.json          — desired package set, active release id, metadata
  active-release         — plain-text pointer file with the current release id
  releases/
    0001/
      package.json
      node_modules/
    0002/
      ...
  staging/               — build area for candidate releases
```

The install/remove flow:

1. read current manifest and build a candidate dependency set
2. create a fresh staging directory with a generated `package.json`
3. run `npm install --production` with streamed output
4. validate the candidate using `createRequire()` and `require.resolve()` for each package
5. promote to a new numbered release via directory rename
6. update the `active-release` pointer file (write-to-temp-then-rename for near-atomic switch)
7. update `manifest.json`

A failed install never modifies the active release. The staging directory is cleaned up on failure. The previous good release remains active and both execution paths continue working.

### Shared runtime resolution

Both execution paths resolve packages from the same active release:

- **Published endpoints (API container)**: `executeWorkflowEndpoint()` passes a `ManagedCodeRunner` instance to `runGraph()` via the existing `codeRunner` option. On each `runCode()` call, `ManagedCodeRunner` reads the `active-release` pointer file and creates a `require` function rooted in that release's `node_modules`. Falls back to standard `NODE_PATH` resolution when no managed release exists.

- **Editor execution (executor container)**: The `bundle-executor.cjs` build-time patch replaces `NodeCodeRunner`'s `createRequire` call with dynamic resolution that reads the `active-release` pointer file on every Code node invocation. Falls back to the original executor bundle resolution when no managed release exists.

Both paths read the pointer file synchronously per invocation. Because `createRequire()` is called fresh each time (not cached), new releases take effect immediately without process restarts.

### Persistence

Runtime library state lives in a dedicated Docker named volume (`rivet_runtime_libs`) mounted at `/data/runtime-libraries` in both the API and executor containers. The `RIVET_RUNTIME_LIBRARIES_ROOT` environment variable is the single source of truth for the path.

Installed libraries survive container restarts and image rebuilds. On startup, the API runs a reconciliation step that validates the active release directory exists, syncs the manifest with the pointer file, and cleans up old releases (keeping the last 5).

In dev mode, `scripts/dev.mjs` sets `RIVET_RUNTIME_LIBRARIES_ROOT` to `.data/runtime-libraries` under the repo root.

### Fallback behavior

When no managed runtime libraries are installed (no `active-release` file exists), both execution paths continue working using image-baked dependencies via `NODE_PATH`. This ensures backward compatibility with existing setups where `wrapper/executor/package.json` dependencies (such as `sharp`) are installed at Docker build time.

### Implementation files

- `wrapper/api/src/runtime-libraries/manifest.ts` — manifest and pointer file read/write helpers
- `wrapper/api/src/runtime-libraries/job-runner.ts` — staging, npm install, validation, promotion
- `wrapper/api/src/runtime-libraries/managed-code-runner.ts` — `ManagedCodeRunner` implementing the `CodeRunner` interface
- `wrapper/api/src/runtime-libraries/exec-streaming.ts` — streaming `child_process.spawn` wrapper
- `wrapper/api/src/runtime-libraries/startup.ts` — startup reconciliation and old release cleanup
- `wrapper/api/src/routes/runtime-libraries.ts` — API route handler
- `wrapper/web/dashboard/RuntimeLibrariesModal.tsx` — modal component
- `wrapper/web/dashboard/RuntimeLibrariesModal.css` — modal styles
- `wrapper/web/dashboard/runtimeLibrariesApi.ts` — client API helper
- `ops/bundle-executor.cjs` — executor-side dynamic require patch

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
- `Ctrl+S` / `Cmd+S` still save the active file-backed workflow project correctly
- the selected project is still highlighted in the `Projects` pane
- collapsed parent folders of the selected project still auto-expand so the selected item is visible
- the pane still scrolls the selected project into view when needed
- workflow folders and projects are still creatable from the dashboard
- workflow folders and projects are still movable on disk through drag and drop
- moving an already-open project still preserves later save behavior without forcing a reopen
- project settings metadata still follows workflow moves because the wrapper moves the related settings sidecar together with the project
- the workflow library is still constrained to the validated workflow root
- the app still uses API-backed and websocket-backed hosted services instead of assuming desktop-native integrations
- the active project section and project settings popup still reflect the currently selected workflow project, defaulting to the opened workflow project when nothing else is selected
- runtime libraries installed through the manager are available to Code nodes in both editor runs and published endpoint calls without restarting containers
- a failed runtime library install does not break the currently active release or disrupt running workflows
- the runtime library trigger button appears at the bottom of the `Projects` pane when the pane is open

## Current practical outcome

This repository produces a maintainable, self-hosted browser deployment of Rivet with a clear separation between:

- upstream vendor code
- wrapper-owned hosted integrations
- runtime/deployment infrastructure

The resulting app is not just the raw upstream editor in a browser tab. It is a hosted Rivet distribution with a wrapper-owned workflow-management layer around the upstream editor, while still trying to preserve upstream behavior wherever practical.
