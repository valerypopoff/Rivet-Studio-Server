# Self-Hosted Rivet - Operational Runbook

## Additional docs

- [Architecture](./docs/architecture.md)
- [Development](./docs/development.md)
- [Editor bridge](./docs/editor-bridge.md)
- [Workflow publication](./docs/workflow-publication.md)
- [Runtime libraries](./docs/runtime-libraries.md)

## Quick Start

### Prerequisites

- Node.js 20+ and npm
- Docker and Docker Compose
- upstream `rivet/` source in repo root

### Start

```bash
npm run prod
```

Access the app at `http://localhost:8080` unless `RIVET_PORT` changes it.

Useful follow-up commands:

```bash
npm run prod:docker:ps
npm run prod:docker:logs
npm run prod:down
```

### Development with Docker

From the repo root:

`npm run dev`

Useful follow-up commands:

```bash
npm run dev:docker:ps
npm run dev:docker:logs
npm run dev:down
```

## Runtime shape

```text
Browser -> nginx (proxy)
           |- / -> web
           |- /api/* -> api
           `- /ws/executor* -> executor
```

## Security

- filesystem access is restricted to configured roots
- env var access is allowlist-only
- shell commands are allowlist-only
- path traversal is rejected on path parameters

### Optional external UI gate

- set `RIVET_KEY` to the shared secret
- set `RIVET_REQUIRE_WORKFLOW_KEY=true` to require `Authorization: Bearer <RIVET_KEY>` on workflow execution routes
- set `RIVET_REQUIRE_UI_GATE_KEY=true` to gate the browser UI and related websockets
- set `RIVET_UI_TOKEN_FREE_HOSTS` for internal hosts that should bypass the UI gate
