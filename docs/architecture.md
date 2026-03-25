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
- recording metadata indexing lives in `wrapper/api/src/routes/workflows/recordings-db.ts`
- recording shared types and virtual replay path helpers live in `wrapper/shared/workflow-recording-types.ts`
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
| `RIVET_RECORDINGS_ENABLED` | Enable workflow endpoint recording persistence | `true` |
| `RIVET_RECORDINGS_COMPRESS` | Recording blob encoding (`gzip` or `identity`) | `gzip` |
| `RIVET_RECORDINGS_GZIP_LEVEL` | Gzip compression level for recording blobs | `4` |
| `RIVET_RECORDINGS_INCLUDE_PARTIAL_OUTPUTS` | Include partial node outputs in stored recordings | `false` |
| `RIVET_RECORDINGS_INCLUDE_TRACE` | Include trace data in stored recordings | `false` |
| `RIVET_RECORDINGS_DATASET_MODE` | Dataset snapshot mode (`none` or `all`) | `none` |
| `RIVET_RECORDINGS_RETENTION_DAYS` | Automatic retention window for recordings | `14` |
| `RIVET_RECORDINGS_MAX_RUNS_PER_WORKFLOW` | Per-workflow run cap before oldest recordings are deleted | `5000` |
| `RIVET_RECORDINGS_MAX_TOTAL_BYTES` | Global compressed-byte cap across all recordings (`0` disables) | `0` |
| `RIVET_RECORDINGS_MAX_PENDING_WRITES` | Background recording write queue size before new recordings are dropped | `100` |
| `RIVET_PORT` | External port for Docker stack | `8080` |
| `RIVET_KEY` | Shared auth secret | (none) |

In Docker-based modes:

- `RIVET_WORKFLOWS_HOST_PATH` backs the workflow root and therefore stores live projects, `.published/` snapshots, and `.recordings/` blob bundles
- `RIVET_RUNTIME_LIBS_HOST_PATH` backs managed runtime library storage
- `RIVET_APP_DATA_ROOT` stores app-level state such as the SQLite recording index (`recordings.sqlite`)

The current recording design is hybrid:

- compressed replay artifacts live under the workflow tree for simple filesystem cleanup and portability
- a SQLite index under the app-data root stores workflow/run metadata, stats, and pagination state for the dashboard UI

The API container now relies on Node's built-in `node:sqlite` module for that index, so the container/runtime baseline is Node 24+.

## Design rule

Hosted behavior should be implemented in the wrapper layer first. Changes to `rivet/` should stay exceptional.
