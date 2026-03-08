# Self-hosted Rivet Wrapper

## What this application is

This repository hosts a browser-based, self-hosted distribution of Rivet.

It is not a forked rewrite of Rivet. The core editor and most product behavior still come from the vendored upstream source in `rivet/`. This repository adds the hosted platform layer around that upstream app so it can run correctly in a browser on a trusted self-hosted machine.

In practical terms, the application provides:

- the upstream Rivet editor running in the browser
- hosted file open/save behavior through an API instead of desktop-native access
- a wrapper-owned workflow dashboard for organizing workflow projects
- Dockerized backend, proxy, and executor services
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

This replaces desktop-native capabilities with server-side operations exposed over HTTP, including file access, workflow library management, and related hosted integrations.

### `executor`

Runs the Node-side Rivet executor and debugger service.

This provides hosted Node execution mode and websocket-based debugging/event streaming.

### `proxy`

nginx entrypoint for the full stack.

It routes:

- browser requests to the web app
- `/api/*` traffic to the compatibility backend
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
- plugin and shell-related hosted endpoints
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
- loading referenced projects
- running allowlisted shell commands
- managing plugin installation/loading
- exposing controlled environment/config values to the hosted frontend

The browser talks to this service through wrapper shims and overrides instead of talking directly to the user's machine.

## Workflow dashboard

The hosted app boots into a wrapper-owned dashboard shell around the upstream editor.

This dashboard is the main wrapper-owned UX layer and is one of the most regression-sensitive parts of the app.

### Dashboard layout and behavior

- the left panel is wrapper-owned UI from `wrapper/web/dashboard/`
- the main editor area remains the upstream Rivet editor
- the left `Projects` pane can be resized by dragging its right edge
- the `Projects` pane can be collapsed from the header
- when the pane is collapsed, a restore button is shown in the bottom-left corner of the window
- when zero editor project tabs are open, the wrapper forces the `Projects` pane open even if the user had previously collapsed it
- when zero editor project tabs are open, the dashboard hides the embedded editor surface and shows a wrapper-owned empty state instead of Rivet's default start screen

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
- selecting a project from the pane reuses the normal hosted project-open flow rather than introducing a second editor state system
- opening a project from the pane normally activates or adds an editor tab instead of replacing the current tab

### Active project visibility

- when the active editor project is inside a collapsed workflow folder, the pane automatically expands all ancestor folders necessary to expose the active item
- when the active editor project changes, the pane automatically scrolls the highlighted project row into view

### Save behavior

- the wrapper-owned `Save` button in the `Projects` pane is driven by the editor's active tab rather than stale last-loaded state
- when the active editor tab is a file-backed workflow project, the wrapper `Save` action saves that exact file path
- the dashboard maps `Ctrl+S` / `Cmd+S` to that same hosted save behavior
- when the active editor is not a path-backed workflow project, or when no tabs are open, the wrapper `Save` button is hidden

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
- hosted `Save As` defaults to `/workflows/...` so manually saved hosted projects and dashboard-created projects converge on the same library root

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
- failing fast if an upstream executor snippet changes in a way that would silently break the hosted patch

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
- the active project is still highlighted in the `Projects` pane
- collapsed parent folders of the active project still auto-expand so the active item is visible
- the pane still scrolls the active project into view when needed
- workflow folders and projects are still creatable from the dashboard
- workflow folders and projects are still movable on disk through drag and drop
- moving an already-open project still preserves later save behavior without forcing a reopen
- the workflow library is still constrained to the validated workflow root
- the app still uses API-backed and websocket-backed hosted services instead of assuming desktop-native integrations

## Current practical outcome

This repository produces a maintainable, self-hosted browser deployment of Rivet with a clear separation between:

- upstream vendor code
- wrapper-owned hosted integrations
- runtime/deployment infrastructure

The resulting app is not just the raw upstream editor in a browser tab. It is a hosted Rivet distribution with a wrapper-owned workflow-management layer around the upstream editor, while still trying to preserve upstream behavior wherever practical.
