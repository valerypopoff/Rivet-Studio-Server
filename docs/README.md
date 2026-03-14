# Self-Hosted Rivet - Operational Runbook

## Additional docs

- [Architecture](./architecture.md)
- [Development](./development.md)
- [Editor bridge](./editor-bridge.md)
- [Workflow publication](./workflow-publication.md)
- [Runtime libraries](./runtime-libraries.md)

## Quick Start

### Prerequisites

- Docker and Docker Compose
- upstream `rivet/` source in repo root

### Deploy

```bash
cd ops
cp .env.example .env
# Edit .env with your API keys
docker compose up -d --build
```

Access the app at `http://localhost:8080` unless `RIVET_PORT` changes it.

### Development with Docker

From the repo root:

```bash
npm run dev
```

Useful follow-up commands:

```bash
npm run dev:docker:ps
npm run dev:docker:logs
npm run dev:down
```

### Development without Docker

1. Install upstream deps and build shared packages.
2. Run `npm --prefix wrapper/api run dev`.
3. Run `npm --prefix wrapper/web run dev`.
4. Run the upstream executor when Node execution mode is needed.

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
