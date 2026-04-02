# Architecture

## Repository layout

- `rivet/` is upstream Rivet source. `npm run setup` may clone it as a Git checkout for local development, while `npm run setup:rivet` downloads a versioned upstream snapshot for Docker builds.
- `wrapper/web/` contains the hosted dashboard, browser entrypoint, and browser-safe overrides of upstream editor behavior.
- `wrapper/api/` contains workflow management, publication, recordings, runtime-library management, native IO shims, plugin install/load routes, and guarded shell/config endpoints.
- `wrapper/shared/` contains browser/server contracts such as hosted env constants, editor-bridge messages, workflow types, and recording helpers.
- `wrapper/executor/` is the packaged Node executor used behind the executor websocket.
- `ops/` contains Dockerfiles, Compose files, nginx templates, and bootstrap scripts for containerized modes.
- `scripts/` contains the root launchers, environment loading, and upstream bootstrap helpers.

## Runtime shape

```text
Browser
  |- /                       -> dashboard shell
  |- /?editor               -> hosted Rivet editor inside an iframe
  |- /api/*                 -> wrapper API
  |- /ws/latest-debugger    -> API-hosted latest-workflow debugger websocket
  |- /ws/executor/internal  -> executor websocket used by the hosted editor
  `- /ws/executor           -> executor websocket kept for upstream-compatible clients
```

In Docker dev and production, nginx fronts the stack and injects the trusted proxy header the API expects.
In local direct-process mode, the services run separately without nginx.

## Hosted UI model

- The top-level page is the wrapper dashboard. It renders the workflow library, project settings, runtime libraries, run recordings, and an `<iframe src="/?editor">`.
- The workflow library tree now includes custom context menus on both project and folder entries.
- Project rows currently expose download and duplicate actions.
- Folder rows currently expose `Create project` and `Upload project`.
- Folder-level project creation now lives only in the folder context menu, not in an inline `+` button on the row.
- `Create project` prompts for a name, creates a new blank `.rivet-project` in the target folder through the workflow API, expands that folder, refreshes the tree, and opens the new project in the editor.
- `Duplicate` creates a sibling project file through the API and refreshes the tree without changing the current selection or editor tab.
- `Download` streams a saved `.rivet-project` file to the browser. It ignores unsaved editor changes and, for `unpublished_changes`, lets the user choose between the saved live file and the published snapshot. The download flow also leaves selection, open tabs, and folder expansion unchanged.
- `Upload project` opens a browser file picker, uploads a chosen `.rivet-project` into the target folder, refreshes the tree, and leaves selection, open tabs, and folder expansion unchanged.
- Browser picker filtering for Rivet's custom file extensions is not fully reliable across browsers, so the dashboard validates the selected filename after picking and the API validates it again before writing anything.
- The iframe renders the upstream Rivet app plus `EditorMessageBridge`, which coordinates open/save/delete/replay commands with the dashboard via `window.postMessage`.
- Editor keyboard node actions such as `Ctrl+C`, `Ctrl+V`, and `Ctrl+D` remain editor-local behavior inside the iframe. The hosted wrapper now makes the node canvas itself a focus target and clears stale editor search/context-menu input focus on normal canvas interactions so those shortcuts behave like the desktop app instead of depending on whichever editor input was focused last.
- `HostedIOProvider` replaces desktop file APIs with API-backed load/save behavior and supports virtual replay paths of the form `recording://<recordingId>/replay.rivet-project`.
- Wrapper-specific UI lives under `wrapper/web/dashboard/`. Upstream editor UI still lives under `rivet/packages/app/`.

## API surface overview

- `/api/workflows/*` manages workflow folders/projects, project creation/duplication/uploading/downloading, publication, movement/rename, and the recordings browser APIs.
- `/api/runtime-libraries/*` manages runtime-library state plus install/remove jobs and live log streaming over SSE.
- `/api/native/*` exposes the hosted editor's filesystem API, constrained to allowed roots and supported base dirs.
- `/api/projects/*` exposes lightweight project discovery for the hosted IO provider.
- `/api/plugins/*` downloads, extracts, and loads NPM plugins for upstream plugin flows.
- `/api/shell/exec` runs allowlisted shell commands (`git` and `pnpm` by default, extendable via env).
- `/api/config`, `/api/path/*`, and `/api/config/env/:name` expose hosted-mode configuration, app-data paths, and allowlisted env vars.
- `POST ${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}/:endpointName` executes the frozen published snapshot.
- `POST ${RIVET_LATEST_WORKFLOWS_BASE_PATH}/:endpointName` executes the latest live project file for a published workflow.
- `POST /internal/workflows/:endpointName` is an internal published-only execution route mounted on the API service and not exposed through nginx.

## Core wrapper seams

- Workflow library management, publication, execution, and recordings live in `wrapper/api/src/routes/workflows/`.
- Recording metadata indexing lives in `wrapper/api/src/routes/workflows/recordings-db.ts`.
- Runtime-library management lives under `wrapper/api/src/runtime-libraries/`.
- Dashboard/editor iframe coordination lives in `wrapper/shared/editor-bridge.ts` and `wrapper/web/dashboard/`.
- Hosted browser/file IO lives in `wrapper/web/io/HostedIOProvider.ts`.
- Shared browser/backend contracts live in `wrapper/shared/`.

## Storage model

| Area | Purpose | Local direct-process default | Docker default |
|---|---|---|---|
| `RIVET_WORKSPACE_ROOT` | Allowed workspace root for general hosted file operations | repo root | `/workspace` |
| `RIVET_WORKFLOWS_ROOT` | Live workflow tree, `.published/`, and `.recordings/` | `<repo>/workflows` | `/workflows` |
| `RIVET_APP_DATA_ROOT` | App-level state such as plugins, logs, and `recordings.sqlite` | `<repo>/.data/rivet-app` | `/data/rivet-app` |
| `RIVET_RUNTIME_LIBRARIES_ROOT` | Managed runtime-library storage | `<repo>/.data/runtime-libraries` | `/data/runtime-libraries` |

In Docker-based modes:

- `RIVET_WORKFLOWS_HOST_PATH` backs `/workflows`, so it stores live projects, published snapshots, and recording bundles.
- `RIVET_RUNTIME_LIBS_HOST_PATH` backs `/data/runtime-libraries`.
- the app-data directory is a separate volume and holds `recordings.sqlite`, plugin files, and app logs.

## Important environment variables

### Routing and auth

- `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH` and `RIVET_LATEST_WORKFLOWS_BASE_PATH` change the public execution route prefixes.
- `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER` enables the API-hosted `/ws/latest-debugger` websocket for latest-workflow runs only.
- `RIVET_KEY` is the shared secret used for public workflow bearer auth, proxy-auth token derivation, and the optional UI gate.
- `RIVET_REQUIRE_WORKFLOW_KEY` enables `Authorization: Bearer <RIVET_KEY>` checks on the public workflow routes.
- `RIVET_REQUIRE_UI_GATE_KEY` enables the browser-side nginx gate.
- `RIVET_UI_TOKEN_FREE_HOSTS` lists hosts that bypass the UI gate and public workflow bearer auth.

### Safety and compatibility

- `RIVET_ENV_ALLOWLIST` extends the hosted env shim beyond the built-in OpenAI vars.
- `RIVET_SHELL_ALLOWLIST` extends the hosted shell-command allowlist beyond `git` and `pnpm`.
- `RIVET_EXTRA_ROOTS` adds more allowed filesystem roots.
- `RIVET_COMMAND_TIMEOUT` and `RIVET_MAX_OUTPUT` bound hosted shell execution.

### Recording defaults

Workflow recording settings are documented in detail in [workflow-publication.md](workflow-publication.md). The current defaults are:

- enabled by default
- `gzip` compression at level `4`
- retention window `14` days
- `100` max pending background writes
- `100` max runs per endpoint
- dataset snapshots disabled by default
- trace and partial-output capture disabled by default

## Dev and production modes

| Mode | Entry command | Browser entry | Notes |
|---|---|---|---|
| Local direct-process | `npm run dev:local` | `http://localhost:5174` | Runs API, web, and executor directly. Good for process-level work, but nginx-specific routing/auth behavior is not reproduced exactly. |
| Docker dev | `npm run dev` | `http://localhost:8080` by default | Closest to production while still using bind mounts and a Vite dev server. The proxy port can be overridden with `RIVET_PORT`. |
| Production-style Docker | `npm run prod` | `http://localhost:8080` by default | Uses prebuilt images when available, otherwise falls back to local builds. The proxy port can be overridden with `RIVET_PORT`. |

The API now depends on Node's built-in `node:sqlite`, so host-based API execution requires Node 24+.

## Boundary guidelines

- Treat `rivet/` as replaceable upstream code, not as the default home for hosted features.
- Prefer implementing hosted behavior in `wrapper/` first.
- `wrapper/shared/` is for contracts both the browser and server need.
- Route files should stay thin request/response glue; domain logic belongs in helpers or service modules.
