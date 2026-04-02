# Access And Routing

This document describes the current external route families, the nginx gate, and the trust boundary between `proxy`, `api`, and `executor`.

## Proxy-exposed routes

The Docker dev and production stacks expose these route families through nginx:

| Path | Backing service | Purpose |
|---|---|---|
| `/` | `web` | Wrapper dashboard shell |
| `/?editor` | `web` | Hosted Rivet editor iframe |
| `POST /__rivet_auth` | `api` (`/ui-auth`) | UI gate form exchange |
| `/api/*` | `api` | Wrapper API surface |
| `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}/:endpointName` | `api` | Execute frozen published workflow snapshot |
| `${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}/:endpointName` | `api` | Execute latest live file for a published workflow |
| `/ws/latest-debugger` | `api` | Latest-workflow remote debugger websocket |
| `/ws/executor/internal` | `executor` | Hosted editor execution websocket |
| `/ws/executor` | `executor` | Upstream-compatible executor websocket path |

The nginx configs also set `client_max_body_size 100m`, so large API/editor payloads are allowed up to that limit.

## `/api/*` route families

The wrapper API currently exposes these groups behind `/api`:

- `/api/workflows/*`
  - `GET /api/workflows/tree`
  - `POST /api/workflows/move`
  - `POST|PATCH|DELETE /api/workflows/folders`
  - `POST|PATCH|DELETE /api/workflows/projects`
  - `POST /api/workflows/projects/duplicate`
  - `POST /api/workflows/projects/upload`
  - `POST /api/workflows/projects/download`
  - `POST /api/workflows/projects/publish`
  - `POST /api/workflows/projects/unpublish`
  - `GET /api/workflows/recordings/workflows`
  - `GET /api/workflows/recordings/workflows/:workflowId/runs?page=1&pageSize=20&status=all|failed`
  - `GET /api/workflows/recordings/:recordingId/recording`
  - `GET /api/workflows/recordings/:recordingId/replay-project`
  - `GET /api/workflows/recordings/:recordingId/replay-dataset`
  - `DELETE /api/workflows/recordings/:recordingId`
- `/api/runtime-libraries/*`
  - `GET /api/runtime-libraries/`
  - `POST /api/runtime-libraries/install`
  - `POST /api/runtime-libraries/remove`
  - `GET /api/runtime-libraries/jobs/:jobId`
  - `GET /api/runtime-libraries/jobs/:jobId/stream`
- `/api/native/*`
  - hosted filesystem read/write/list/remove helpers used by the editor
- `/api/projects/*`
  - `GET /api/projects/list`
  - `POST /api/projects/open-dialog`
- `/api/plugins/*`
  - `POST /api/plugins/install-package`
  - `POST /api/plugins/load-package-main`
- `/api/shell/exec`
  - allowlisted shell execution
- `/api/config`, `/api/path/app-local-data-dir`, `/api/path/app-log-dir`, `/api/config/env/:name`
  - hosted env/config helpers

`GET /healthz` lives on the API service itself and is used by the Docker healthchecks.

Current duplicate-route behavior:

- `POST /api/workflows/projects/duplicate` accepts `{ "relativePath": string, "version"?: "live" | "published" }`
- it returns `201 { "project": WorkflowProjectItem }`
- it creates a sibling `.rivet-project` using `Name Copy`, then `Name Copy 1`, `Name Copy 2`, and so on
- `version: "live"` duplicates the saved live workflow file
- `version: "published"` resolves the published snapshot through the publication model and returns `409` if no published version is available
- it writes only the new project file; dataset sidecars, wrapper settings, published snapshots, and recordings are intentionally not copied
- the dashboard calls this route directly from the project-row context menu: `unpublished` duplicates `live`, `published` duplicates `published`, and `unpublished_changes` opens a chooser for the user to pick which saved version to duplicate

Current create-project route behavior:

- `POST /api/workflows/projects` accepts `{ "folderRelativePath"?: string, "name": string }`
- it returns `201 { "project": WorkflowProjectItem }`
- it creates a new blank `.rivet-project` file in the target folder and uses the provided name for both the filename base and initial project title
- the dashboard currently calls this route from the folder-row context menu's `Create project` action
- folder-level project creation currently exists only in that custom folder context menu, not in an inline row button
- if the target folder already contains that exact project name, the route returns `409`

Current upload-route behavior:

- `POST /api/workflows/projects/upload` accepts `{ "folderRelativePath": string, "fileName": string, "contents": string }`
- it returns `201 { "project": WorkflowProjectItem }`
- it parses the uploaded `.rivet-project`, assigns a fresh workflow metadata ID, updates the stored title to the final saved filename base, and writes only a new project file into the selected folder
- name collisions are resolved as `Name`, then `Name 1`, `Name 2`, and so on
- the dashboard calls this route directly from the folder-row context menu after reading the selected local file in the browser
- browser file-picking is still validated client-side and server-side; some browsers do not reliably pre-filter Rivet's custom `.rivet-project` extension in the native picker
- uploads intentionally ignore unsaved editor changes, do not use the editor bridge, and never create sidecars, published snapshots, or recordings automatically
- invalid project files or wrong extensions return `400`; a missing target folder returns `404`

Current download-route behavior:

- `POST /api/workflows/projects/download` accepts `{ "relativePath": string, "version": "live" | "published" }`
- it returns the raw `.rivet-project` file body, not JSON
- it currently serves `application/x-yaml; charset=utf-8` with `Content-Disposition: attachment`
- it sets attachment headers so the browser downloads the file with a status tag such as `Name [published].rivet-project`
- `version: "live"` reads the saved live workflow file from the workflow tree
- `version: "published"` resolves the published snapshot through the publication model and returns `409` if no published version is available
- the dashboard calls this route directly from the project-row context menu: `unpublished` downloads `live`, `published` downloads `published`, and `unpublished_changes` opens a chooser for the user to pick which saved version to download
- downloads intentionally ignore unsaved editor changes and never include sidecars or recordings

## UI gate

The browser/editor surface can be protected at the nginx layer:

- `RIVET_REQUIRE_UI_GATE_KEY=true` enables the gate.
- `RIVET_KEY` is the shared secret used for the gate.
- `RIVET_UI_TOKEN_FREE_HOSTS` lists hosts that bypass the gate.

When the gate is enabled for a host that is not exempt:

- `GET /` serves the prompt page from `ops/ui-gate-prompt.html`
- `POST /__rivet_auth` forwards to the API's internal `/ui-auth` route
- the API validates the submitted `key` or `token` form field
- on success the response sets an HTTP-only `rivet_ui_token` cookie
- the cookie then gates `/`, `/api/*`, `/ws/executor*`, and `/ws/latest-debugger`

If the gate is enabled but `RIVET_KEY` is empty, nginx/API do not fall back to open access for non-exempt hosts; they deny the gated requests.

## Trusted proxy boundary

The intended access path is:

```text
browser -> nginx -> api / executor
```

The API independently enforces that boundary:

- `/api/*` requires the trusted proxy header
- `/ui-auth` requires the trusted proxy header
- `/ws/latest-debugger` requires the trusted proxy header during websocket upgrade

nginx injects `X-Rivet-Proxy-Auth`, derived from `RIVET_KEY`, for those requests.
Direct access to the API container for `/api/*`, `/ui-auth`, or `/ws/latest-debugger` bypasses that header and is rejected.

The public workflow execution routes are mounted outside `/api`, so they do not use the `requireAuth` middleware. They still rely on nginx to mediate access and, for token-free hosts, inject the token-free-host hint.

## Workflow execution contract

All three workflow execution handlers are `POST`-only:

- `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}/:endpointName`
- `${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}/:endpointName`
- `/internal/workflows/:endpointName`

Current request/response behavior:

- the incoming JSON body becomes the workflow's `input` value
- an empty request body is treated as `{}`
- if the workflow's final `output` port is typed as `any`, the HTTP response body is that raw value
- otherwise the response body is the full outputs object
- every execution response sets `x-duration-ms`
- if the success payload is an object and does not already include `durationMs`, the API injects `durationMs` into the JSON body
- failures return JSON shaped like `{ "error": { "name"?: string, "message": string }, "durationMs": number }`

## Workflow execution auth

Workflow execution auth is separate from the UI gate:

- `RIVET_REQUIRE_WORKFLOW_KEY=true` enables bearer-token checks on the public workflow routes
- `Authorization: Bearer <RIVET_KEY>` is required on `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` and `${RIVET_LATEST_WORKFLOWS_BASE_PATH}` when enabled
- if the flag is enabled but `RIVET_KEY` is empty, public execution fails with `500`
- hosts listed in `RIVET_UI_TOKEN_FREE_HOSTS` bypass public workflow bearer auth because nginx forwards `X-Rivet-Token-Free-Host: 1`

The internal API-only route:

- `POST /internal/workflows/:endpointName`

is mounted directly on the API service, is not exposed through nginx, and intentionally skips bearer auth for trusted intra-stack callers.

## Latest debugger model

Latest-workflow remote debugging is opt-in and separate from the executor websocket:

- it is enabled only when `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER=true`
- it applies only to latest-workflow endpoint runs
- published workflow endpoint runs never attach the remote debugger
- the browser-facing websocket path is `/ws/latest-debugger`
- when disabled, websocket upgrades on `/ws/latest-debugger` are rejected with `404`

Endpoint recording persistence is unaffected by debugger state. Latest-workflow runs still write normal recording bundles when recordings are enabled.

## Local dev note

`npm run dev` preserves the nginx routing and auth model described above.

`npm run dev:local` does not recreate that proxy boundary. It starts the services directly and serves the web app from Vite on `http://localhost:5174`, so Docker dev remains the authoritative path for validating proxy-injected auth, the UI gate, and production-like routing behavior.
