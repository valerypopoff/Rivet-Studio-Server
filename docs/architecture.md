# Architecture

## Repository layout

- `rivet/` is upstream Rivet source consumed by this repo. `npm run setup` may clone it as a Git checkout for local development, while `npm run setup:rivet` downloads a versioned upstream snapshot for Docker builds. Treat it as read-only input here; repo-specific behavior belongs in the wrapper layer, and real Rivet changes should be contributed upstream.
- `wrapper/web/` contains the hosted dashboard, browser entrypoint, and the tracked alias-based override layer for upstream editor behavior.
- `wrapper/api/` contains workflow management, publication, recordings, runtime-library management, native IO shims, plugin install/load routes, and guarded shell/config endpoints.
- `wrapper/shared/` contains browser/server contracts such as hosted env constants, editor-bridge messages, workflow types, and recording helpers.
- `wrapper/executor/` is the packaged Node executor used behind the executor websocket.
- `ops/` contains Dockerfiles, Compose files, nginx templates, and bootstrap scripts for containerized modes.
- `scripts/` contains the root launchers, environment loading, and upstream bootstrap helpers.

## Runtime shape

The route map below describes logical ownership. In `RIVET_API_PROFILE=combined`, one API process serves both the control-plane and published-execution surfaces. In split deployments, `RIVET_API_PROFILE=control` and `RIVET_API_PROFILE=execution` separate those surfaces into different API workloads.

```text
Browser
  |- /                       -> dashboard shell
  |- /?editor               -> hosted Rivet editor inside an iframe
  |- /api/*                 -> control-plane API
  |- /workflows/*           -> execution-plane API
  |- /workflows-latest/*    -> control-plane API
  |- /ws/latest-debugger    -> control-plane latest-workflow debugger websocket
  |- /ws/executor/internal  -> executor websocket used by the hosted editor
  `- /ws/executor           -> executor websocket kept for upstream-compatible clients
```

In Docker dev and production, nginx fronts the stack and injects the trusted proxy header the API expects.
The repo-local Docker stacks still run the API in `combined` mode, so both workflow route families terminate at the same `api` container there even though the published-vs-latest split remains a first-class deployment contract.
In local direct-process mode, the services run separately without nginx. The Vite dev server only proxies `/api/*` and `/ws/executor*`, so published/latest workflow endpoints, `/ui-auth`, and `/ws/latest-debugger` are not recreated there with production-like routing or trust behavior.

The current runtime keeps the control plane conservative while published execution scales separately:

- control plane
  - dashboard/editor APIs
  - workflow mutation and publication
  - runtime-library admin flows
  - plugin admin flows
  - latest execution and latest debugger
- execution plane
  - published endpoint execution only
  - internal published-only execution for trusted in-cluster callers

## Hosted UI model

- The top-level page is the wrapper dashboard. It renders the workflow library, project settings, runtime libraries, run recordings, and an `<iframe src="/?editor">`.
- The workflow library tree now includes custom context menus on both project and folder entries.
- Project rows currently expose `Rename project`, `Download`, `Duplicate`, and a guarded `Delete project` action.
- Folder rows currently expose `Rename folder`, `Create project`, `Upload project`, and `Delete folder`.
- `Delete folder` is enabled only for empty folders in the dashboard, and the API enforces the same empty-folder rule if called directly.
- The workflow library also exposes a root-level `+ New folder` action that creates top-level folders rather than nested ones.
- Folder-level project creation now lives only in the folder context menu, not in an inline `+` button on the row.
- Projects and folders can also be moved by drag-and-drop between folders or back to the root, with the dashboard retargeting open editor tabs when project paths change.
- `Create project` prompts for a name, creates a new blank `.rivet-project` in the target folder through the workflow API, expands that folder, refreshes the tree, and opens the new project in the editor.
- `Rename project` in the project context menu does not rename inline. It opens the existing Project Settings modal for that project, and the rename flow still happens there.
- `Duplicate` creates a sibling project file through the API and refreshes the tree without changing the current selection or editor tab. Duplicate names now use the same saved-version tag model as downloads, such as `Name [published] Copy` or `Name [unpublished changes] Copy`; exact-name collisions get numbered variants, but duplicate-of-duplicate naming otherwise stays literal. For `unpublished_changes`, the dashboard opens a chooser so the user can duplicate either the saved live version or the published snapshot.
- `Download` streams a saved `.rivet-project` file to the browser. It ignores unsaved editor changes and, for `unpublished_changes`, lets the user choose between the saved live file and the published snapshot. The download flow also leaves selection, open tabs, and folder expansion unchanged.
- `Delete project` in the project context menu never deletes immediately. For unpublished projects it opens the existing Project Settings modal, where the user must click `Delete project` again. For published or `unpublished_changes` projects it shows a toast telling the user to unpublish first.
- `Upload project` opens a browser file picker, uploads a chosen `.rivet-project` into the target folder, refreshes the tree, and leaves selection, open tabs, and folder expansion unchanged.
- Project Settings shows `Last published at ...` next to the `Published` or `Unpublished changes` status badge. That timestamp comes from stored publication metadata, with a fallback for older already-published projects that predate the explicit field.
- Browser picker filtering for Rivet's custom file extensions is not fully reliable across browsers, so the dashboard validates the selected filename after picking and the API validates it again before writing anything.
- The iframe renders the upstream Rivet app plus wrapper-provided overrides and `EditorMessageBridge`, which coordinates open/save/delete/replay commands with the dashboard via `window.postMessage`.
- Editor keyboard actions such as `Ctrl+C`, `Ctrl+V`, `Ctrl+D`, and iframe-focused `Ctrl+S` stay anchored to editor-side behavior inside the iframe. The hosted wrapper now makes the node canvas itself a focus target, clears stale editor search/context-menu input focus on normal canvas interactions, and suppresses the browser focus ring on the iframe/canvas so those shortcuts behave like the desktop app without leaving a visible white perimeter.
- `HostedIOProvider` replaces desktop file APIs with API-backed load/save behavior and supports virtual replay paths of the form `recording://<recordingId>/replay.rivet-project`.
- Wrapper-specific UI lives under `wrapper/web/dashboard/`. Hosted editor hook/component overrides live under `wrapper/web/overrides/`. Upstream editor UI still lives under `rivet/packages/app/`.

## API surface overview

- `/api/workflows/*` manages workflow folders/projects, project creation/duplication/uploading/downloading, publication, movement/rename, and the recordings browser APIs.
- `/api/runtime-libraries/*` manages runtime-library state, replica readiness, stale-replica cleanup, install/remove jobs, job cancellation, and live log streaming over SSE from the control plane.
- `/api/native/*` exposes the hosted editor's filesystem API, constrained to allowed roots and supported base dirs.
- `/api/projects/*` exposes hosted project discovery and IO helper routes (`/list`, `/open-dialog`, `/load`, `/save`, `/workspace-root`) for the hosted IO provider.
- `/api/plugins/*` downloads, extracts, and loads NPM plugins for upstream plugin flows.
- `/api/shell/exec` runs allowlisted shell commands (`git` and `pnpm` by default, extendable via env).
- `/api/config`, `/api/path/*`, and `/api/config/env/:name` expose hosted-mode configuration, app-data paths, and allowlisted env vars.
- `POST ${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}/:endpointName` executes the frozen published snapshot through the execution-plane API.
- `POST ${RIVET_LATEST_WORKFLOWS_BASE_PATH}/:endpointName` executes the latest live project file for a published workflow through the control-plane API.
- `POST /internal/workflows/:endpointName` is an internal published-only execution route mounted on the execution-plane API service and not exposed through nginx.
- In `managed` mode, those execution routes use API-local derived caches for warm endpoint execution; Postgres plus object storage remain authoritative, and cache invalidation is driven by same-process post-commit clearing plus Postgres `LISTEN/NOTIFY` across both control-plane and execution-plane API replicas.
- A later cleanup pass kept that behavior intact but extracted the managed execution subsystem into focused internal modules so the large managed backend remains orchestration-oriented instead of owning the whole execution state machine inline. The later hardening pass also made the writer replica ignore self-originated `NOTIFY` payloads and tightened listener startup/disposal behavior without changing route contracts or cache semantics.

## Core wrapper seams

- Workflow library management, publication, execution, and recordings live in `wrapper/api/src/routes/workflows/`.
- Managed workflow storage internals now live under `wrapper/api/src/routes/workflows/managed/`, with `backend.ts` acting as a thin facade over `schema.ts`, `catalog.ts`, `revisions.ts`, `publication.ts`, `recordings.ts`, and the execution-support modules.
- Managed warm execution is internally split across `execution-cache.ts`, `execution-invalidation.ts`, and `execution-service.ts`; this is an internal maintainability boundary only, not a separate product/API surface.
- Recording metadata indexing lives in `wrapper/api/src/routes/workflows/recordings-db.ts`.
- Runtime-library management lives under `wrapper/api/src/runtime-libraries/`.
- Dashboard/editor iframe coordination lives in `wrapper/shared/editor-bridge.ts` and `wrapper/web/dashboard/`.
- Hosted browser/file IO lives in `wrapper/web/io/HostedIOProvider.ts`.
- Shared browser/backend contracts live in `wrapper/shared/`.

## Storage model

| Area | Purpose | Local direct-process default | Docker default |
|---|---|---|---|
| `RIVET_WORKSPACE_ROOT` | Allowed workspace root for general hosted file operations | repo root | `/workspace` |
| `RIVET_WORKFLOWS_ROOT` | Filesystem-mode workflow tree plus filesystem-mode `.published/` and `.recordings/` artifacts | `<repo>/workflows` | `/workflows` |
| `RIVET_APP_DATA_ROOT` | App-level state such as plugins, logs, and filesystem-mode `recordings.sqlite` | `<repo>/.data/rivet-app` | `/data/rivet-app` |
| `RIVET_RUNTIME_LIBRARIES_ROOT` | Runtime-library local cache, manifest, and job workspace | `<repo>/.data/runtime-libraries` | `/data/runtime-libraries` |

In Docker-based modes:

- `RIVET_ARTIFACTS_HOST_PATH` can act as a shared host root for filesystem-backed artifacts; the launcher derives `workflows/` and `runtime-libraries/` subfolders from it unless the per-path envs are set explicitly.
- `RIVET_WORKFLOWS_HOST_PATH` backs `/workflows`, so in `filesystem` mode it stores live projects, published snapshots, and recording bundles.
- `RIVET_RUNTIME_LIBS_HOST_PATH` backs `/data/runtime-libraries`.
- the app-data directory is a separate volume and in `filesystem` mode holds `recordings.sqlite`, plugin files, and app logs.

Storage mode decides which of those paths are authoritative:

- `RIVET_STORAGE_MODE=filesystem`
  - workflows are authoritative under `RIVET_WORKFLOWS_ROOT`
  - runtime libraries are authoritative under `RIVET_RUNTIME_LIBRARIES_ROOT`
- `RIVET_STORAGE_MODE=managed`
  - workflow metadata lives in Postgres and workflow blobs live in object storage
  - workflow recording metadata lives in Postgres `workflow_recordings`
  - workflow recording artifacts live in object storage
  - API replicas may keep local warm execution caches for endpoint pointers and immutable revision payloads; those caches are derived accelerators, not a new source of truth
  - runtime-library release metadata, activation state, and job state live in Postgres
  - runtime-library release artifacts live in object storage under the fixed `runtime-libraries/` prefix
  - `RIVET_RUNTIME_LIBRARIES_ROOT` remains a local extracted cache/workspace on each process, not the shared source of truth
  - execution-plane `RIVET_APP_DATA_ROOT` may remain ephemeral because the current published execution path does not use it as authoritative state
  - package-plugin registration is not currently part of the API-hosted published execution contract, so the execution plane does not assume persistent plugin state

## Supported compatibility matrix

Outside Kubernetes, the app still supports two non-cluster compatibility shapes:

| Shape | Status | Notes |
|---|---|---|
| `filesystem + combined` | Supported | Primary backward-compatible single-host mode |
| `filesystem + control` | Supported | Useful for control-plane/admin validation without managed services |
| `filesystem + execution` | Unsupported | Execution-only API requires managed storage |
| `managed + local-docker + combined` | Supported | Existing Docker rehearsal path backed by local Postgres and MinIO |
| `managed + local-docker + control/execution` | Supported through repo-local split validation plus local dependency rehearsal | Use this to keep split-era contracts honest without treating Docker combined mode as proof of the real split topology |

Interpretation rules:

- `local-docker` means `RIVET_STORAGE_MODE=managed` with `RIVET_DATABASE_MODE=local-docker`
- in that shape, workflows and runtime libraries are still authoritative in Postgres plus object storage; the difference is only that those services are local Docker dependencies instead of managed external services
- filesystem mode remains single-host by design and is not a multi-replica scaling target

## Important environment variables

### Routing and auth

- `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH` and `RIVET_LATEST_WORKFLOWS_BASE_PATH` change the public execution route prefixes.
- `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER` enables the API-hosted `/ws/latest-debugger` websocket for latest-workflow runs only.
- `RIVET_KEY` is the shared secret used for proxy-auth token derivation, public workflow bearer auth, and the optional UI gate.
- In any nginx/proxy-fronted deployment such as Docker or Kubernetes, `RIVET_KEY` must always be present on both `proxy` and `api` even if `RIVET_REQUIRE_WORKFLOW_KEY=false` and `RIVET_REQUIRE_UI_GATE_KEY=false`, because `/api/*`, `/ui-auth`, and `/ws/latest-debugger` still rely on the trusted proxy header derived from that key.
- `RIVET_REQUIRE_WORKFLOW_KEY` enables `Authorization: Bearer <RIVET_KEY>` checks on the public workflow routes.
- `RIVET_REQUIRE_UI_GATE_KEY` enables the browser-side nginx gate.
- `RIVET_UI_TOKEN_FREE_HOSTS` lists hosts that bypass the UI gate and public workflow bearer auth.

### Storage and runtime libraries

- `RIVET_STORAGE_MODE` switches both workflows and runtime libraries together between `filesystem` and `managed`.
- `RIVET_DATABASE_MODE`, `RIVET_DATABASE_CONNECTION_STRING`, and `RIVET_DATABASE_SSL_MODE` define the shared managed Postgres connection used by workflow storage and managed runtime libraries.
- `RIVET_STORAGE_URL` is the recommended object-storage config entrypoint; alternatively use the explicit tuple of `RIVET_STORAGE_BUCKET`, `RIVET_STORAGE_REGION`, `RIVET_STORAGE_ENDPOINT`, `RIVET_STORAGE_ACCESS_KEY_ID`, `RIVET_STORAGE_ACCESS_KEY`, and `RIVET_STORAGE_FORCE_PATH_STYLE`.
- `RIVET_ARTIFACTS_HOST_PATH` is the primary public filesystem-mode host root. The per-path host envs remain launcher-level compatibility overrides rather than the preferred contract.
- `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS` enables additive managed execution timing headers for endpoint resolve/materialize/execute stages.
- `RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS` tunes managed runtime-library background reconciliation for API and executor processes.
- `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS` and `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS` tune how long stale managed replica-status rows are kept and how often background cleanup runs.
- `RIVET_RUNTIME_PROCESS_ROLE=api|executor` tells managed runtime-library readiness reporting which process role the current runtime represents.
- `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint|editor|none` lets the split topology report execution-plane API replicas as `endpoint`, executor replicas as `editor`, and control-plane API replicas as `none`.
- `RIVET_ENV_FILE` is a launcher-level override that lets repo tooling load an explicit env file instead of `.env` / `.env.dev`; it exists for repeatable compatibility verification and custom local rehearsals

Development-only execution measurement is available through:

- `npm --prefix wrapper/api run workflow-execution:measure -- --base-url http://localhost:8080 --endpoint hello-world --kind published --runs 5 --warmups 1`
- this tool is read-only and meant for cold-hit vs warm-hit diagnosis; it does not change server behavior or introduce a new public API surface

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
| Local direct-process | `npm run dev:local` | `http://localhost:5174` | Runs API, web, and executor directly. Good for process-level work, but it does not recreate nginx's trusted-proxy wiring, so browser-driven `/api/*`, `/ui-auth`, and `/ws/latest-debugger` behavior is not representative there. |
| Docker dev | `npm run dev` | `http://localhost:8080` by default | Closest to production while still using bind mounts and a Vite dev server. The proxy port can be overridden with `RIVET_PORT`. |
| Production-style Docker | `npm run prod` | `http://localhost:8080` by default | Uses prebuilt images when available, otherwise falls back to local builds. The proxy port can be overridden with `RIVET_PORT`. |

The API now depends on Node's built-in `node:sqlite`, so host-based API execution requires Node 24+.

## Boundary guidelines

- Treat `rivet/` as replaceable upstream code, not as the default home for hosted features.
- Prefer implementing hosted behavior in `wrapper/` first.
- If a hosted fix needs to change upstream editor behavior, prefer `wrapper/web/overrides/` plus Vite aliasing over editing `rivet/` directly.
- `wrapper/shared/` is for contracts both the browser and server need.
- Route files should stay thin request/response glue; domain logic belongs in helpers or service modules.
