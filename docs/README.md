# Self-Hosted Rivet — Operational Runbook

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Upstream `rivet/` source in repo root

### Deploy
```bash
cd ops
cp .env.example .env
# Edit .env with your API keys
docker compose up -d --build
```

Access at `http://localhost:8080` (or the port set in `RIVET_PORT`).

### Development (with Docker)

From the repo root:

```bash
npm run dev
```

This starts the Docker development stack in detached mode, waits for healthy services, and prints container diagnostics if startup fails.

Useful follow-up commands:

```bash
npm run dev:docker:ps
npm run dev:docker:logs
npm run dev:down
```

### Development (without Docker)

1. **Install upstream deps & build core packages:**
   ```bash
   cd rivet && yarn install
   yarn workspace @ironclad/rivet-core run build
   yarn workspace @ironclad/trivet run build
   ```

2. **Start API backend:**
   ```bash
   cd wrapper/api && npm install && npm run dev
   ```

3. **Start wrapper frontend dev server:**
   ```bash
   cd wrapper/web && npm install && npm run dev
   ```

4. **Start executor (optional, for Node executor mode):**
   ```bash
   cd rivet && yarn workspace @ironclad/rivet-node run build
   yarn workspace @ironclad/rivet-app-executor run build
   node packages/app-executor/bin/executor.mjs --port 21889
   ```

### Update Upstream
```bash
# Replace rivet/ with new upstream
bash ops/update-check.sh
# If passes: rebuild & deploy
docker compose up -d --build
```

## Architecture

```
Browser → nginx (proxy)
           ├── / → web (static frontend)
           ├── /api/* → api (Node.js backend)
           └── /ws/executor* → executor (WebSocket, port 21889)
```

## Volumes
- `rivet_workspace` — project files, mounted at `/workspace` in api
- `rivet_data` — shared plugin cache + logs, mounted in both api and executor

## Security
- Filesystem access restricted to configured roots
- Env var access is allowlist-only
- Shell commands are allowlist-only (git, pnpm by default)
- Path traversal prevention on all path parameters

### Optional external UI gate
- Set `RIVET_ENDPOINT_API_KEY` to your shared secret.
- Set `RIVET_UI_TOKEN_FREE_HOSTS` to a comma-separated list of internal hostnames that should bypass the UI token check.
- All other hosts require `?token=<RIVET_ENDPOINT_API_KEY>` once, then the proxy stores it in an HTTP-only cookie for `/`, `/api/*`, `/ws/executor*`, and `/ws/latest-debugger`.
- Workflow execution routes under `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH` and `RIVET_LATEST_WORKFLOWS_BASE_PATH` are not affected by this gate.
