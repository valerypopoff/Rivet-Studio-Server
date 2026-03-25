# Architecture

## Boundary

- `rivet/` is a local upstream source snapshot downloaded by `npm run setup:rivet`
- `wrapper/` is the hosted integration layer
- `ops/` contains deployment and container wiring
- `scripts/` contains developer entrypoints

## Runtime shape

- `web` serves the browser app and wrapper dashboard
- `api` replaces desktop-native behavior with HTTP endpoints
- `executor` handles Node-side execution and debugging
- `proxy` fronts the stack and applies UI/auth routing rules

## Core wrapper seams

- workflow library management, publication, and recording persistence live in `wrapper/api/src/routes/workflows/`
- dashboard/editor iframe coordination lives in `wrapper/shared/editor-bridge.ts`
- shared browser/backend contracts live in `wrapper/shared/`
- runtime library management lives under `wrapper/api/src/runtime-libraries/`

## Boundary guidelines

- Treat `rivet/` as replaceable upstream code, not as the default home for hosted changes.
- **Never** add hosted features directly in `rivet/`. Wrapper-level alternatives should be exhausted first.
- `wrapper/shared/` is for contracts both the browser and server need (types, type guards, constants).
- `wrapper/web/dashboard/` owns all wrapper-specific UI. Upstream UI code stays in `rivet/packages/app/`.
- Route files should be thin request/response glue. Domain logic belongs in service modules or helpers.

## Dev vs production

| Aspect | Local dev (`npm run dev:local`) | Docker dev (`npm run dev`) | Production (`npm run prod`) |
|---|---|---|---|
| Processes | Three local processes (API, web, executor) | Docker Compose with nginx proxy | Docker Compose with nginx proxy |
| Ports | API on 3100, web on 5173 | Single port via nginx (default 8080) | Single port via nginx |
| Filesystem | `.data/` under repo root | Docker bind mounts from host | Docker named volumes |
| Env loading | `scripts/lib/dev-env.mjs` | Same, plus Docker Compose env | Root `.env` |

## Configuration

Key environment variables (all optional with defaults):

| Variable | Purpose | Default |
|---|---|---|
| `RIVET_WORKSPACE_ROOT` | Root directory for workflow project files | repo root (dev) or `/data/workspace` |
| `RIVET_APP_DATA_ROOT` | App-level persistent data | `.data/rivet-app` (dev) or `/data/rivet-app` |
| `RIVET_RUNTIME_LIBRARIES_ROOT` | Runtime library storage | `.data/runtime-libraries` (dev) or `/data/runtime-libraries` |
| `RIVET_PORT` | External port for Docker stack | `8080` |
| `RIVET_KEY` | Shared auth secret | (none) |

In Docker-based modes, `RIVET_WORKFLOWS_HOST_PATH` controls the host bind mount that backs the workflow root. Both `.published/` snapshots and `.recordings/` execution bundles live inside that tree. `RIVET_RUNTIME_LIBS_HOST_PATH` similarly backs managed runtime library storage.

## Design rule

Hosted behavior should be implemented in the wrapper layer first. Changes to `rivet/` should stay exceptional.
