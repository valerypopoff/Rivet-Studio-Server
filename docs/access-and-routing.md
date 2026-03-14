# Access And Routing

This document describes the externally visible route families, the nginx gate, and the trust boundary between `proxy`, `api`, and `executor`.

## Route families

The stack exposes four important request families through nginx:

- `/` serves the hosted browser app
- `/api/*` serves wrapper compatibility endpoints
- `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}/*` serves the last published workflow snapshot
- `${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}/*` serves the latest working version of a published workflow

Websocket routes are split as follows:

- `/ws/executor/*` proxies to the executor service for editor-driven Node execution
- `/ws/latest-debugger` proxies to the API service for latest-workflow remote debugging

## UI gate

The browser/editor surface can be protected at the nginx layer:

- `RIVET_REQUIRE_UI_GATE_KEY=true` enables the gate
- `RIVET_KEY` is the shared secret
- `RIVET_UI_TOKEN_FREE_HOSTS` lists hosts that bypass the gate

When the gate is enabled for a host that is not exempt:

- `GET /` serves the prompt page from `ops/ui-gate-prompt.html`
- `POST /__rivet_auth` exchanges the entered key for an HTTP-only session cookie
- the cookie is then used for `/`, `/api/*`, `/ws/executor*`, and `/ws/latest-debugger`

## Trusted proxy boundary

The intended external access path is `browser -> nginx -> api/executor`.

The API independently treats nginx as a trusted proxy boundary:

- `/api/*`
- `/ui-auth`
- `/ws/latest-debugger`

These paths are expected to be reached through nginx, not directly against the API container. The API validates the trusted proxy header that nginx injects for those requests.

## Workflow execution auth

Workflow execution auth is separate from the UI gate:

- `RIVET_REQUIRE_WORKFLOW_KEY=true` enables bearer-token checks on public workflow execution routes
- `Authorization: Bearer <RIVET_KEY>` is required on public workflow routes when enabled
- hosts listed in `RIVET_UI_TOKEN_FREE_HOSTS` can bypass public workflow bearer auth because nginx marks them as trusted internal hosts

There is also an internal API-only route:

- `/internal/workflows/:endpointName`

That route is not exposed through nginx and intentionally skips bearer auth so trusted intra-stack callers can use `http://api/internal/workflows/:endpointName`.

## Latest debugger model

Latest-workflow remote debugging is intentionally opt-in and separate from the executor websocket:

- it is enabled only when `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER=true`
- it applies only to latest-workflow endpoint runs
- published workflow endpoint runs remain debugger-free
- the browser-facing websocket is `/ws/latest-debugger`

This means the two debug/execution paths are different:

- editor Node execution uses the executor websocket
- endpoint remote debugging uses the API-hosted latest debugger websocket
