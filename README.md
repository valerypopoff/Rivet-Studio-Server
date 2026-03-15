# Rivet Studio Server - Operational Runbook

This repo exists because Rivet does not provide a cloud-hosted platform for editing workflows and serving them directly as hosted endpoints.

Without this wrapper, a typical workflow is much more manual: install the desktop Rivet app, build the workflow locally, move the `.rivet-project` file into your own backend, write custom code to execute it, and build your own server layer if you want to expose that workflow as an HTTP endpoint. Updating a workflow then usually means going back to a local machine, editing it there, shipping the changed file again, and redeploying the backend that serves it.

Rivet Studio Server turns that into a self-hosted personal Rivet platform you can run on a VM. It gives you both a browser-based Rivet editor and a server that can publish workflows as endpoints. When you need to update a workflow, you edit it in the browser and publish the new version so the same endpoint keeps serving the updated workflow.

## Additional docs

- [Architecture](./docs/architecture.md)
- [Access and routing](./docs/access-and-routing.md)
- [Development](./docs/development.md)
- [Editor bridge](./docs/editor-bridge.md)
- [Workflow publication](./docs/workflow-publication.md)
- [Runtime libraries](./docs/runtime-libraries.md)

## Quick Start

### Prerequisites

- Node.js 20+ and npm
- Git
- Docker and Docker Compose

### Option 1: Fast Deploy with Prebuilt Images

This path does not build Rivet on the server. It pulls prebuilt images from `ghcr.io`.

```bash
npm run prod:fast
```

Access the app at `http://localhost:8080` unless `RIVET_PORT` changes it.

Useful follow-up commands:

```bash
npm run prod:docker:ps
npm run prod:docker:logs
npm run prod:down
```

If you want a specific published image instead of `latest`, set `RIVET_IMAGE_TAG` or override the individual image names in `.env`.

### Option 2: Build Locally from Upstream Rivet Source

#### Bootstrap Upstream Rivet

From the repo root, download the latest stable upstream Rivet tag into `./rivet`:

```bash
npm run setup:rivet
```

The script resolves the newest stable GitHub tag matching `v<major>.<minor>.<patch>` and downloads that release, not the moving `main` branch.

If you need to replace an existing non-empty `rivet/` directory:

```bash
npm run setup:rivet -- --force
```

#### Start

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

`npm run prod` and `npm run prod:local` are the same local-build path.

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
- set `RIVET_UI_TOKEN_FREE_HOSTS` for hosts that should bypass the UI gate
