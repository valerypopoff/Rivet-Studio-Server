# Development

## Setup commands

- `npm run setup`
  - ensures `wrapper/api` and `wrapper/web` dependencies exist
  - clones `rivet/` from the upstream repo if it is missing
  - installs upstream Yarn dependencies and builds `@ironclad/rivet-core` and `@ironclad/rivet-node` when needed
  - expects `rivet/` to be absent or a Git checkout; if `rivet/` already contains a non-Git snapshot from `npm run setup:rivet`, remove or rename it first
- `npm run setup:rivet`
  - downloads the newest stable upstream Rivet tag into `./rivet`
  - use this when you want a clean versioned upstream snapshot for local Docker builds
  - `npm run setup:rivet -- --force` replaces an existing non-empty `rivet/` directory

## Main commands

| Command | What it does | Typical use |
|---|---|---|
| `npm run dev` | Starts the Docker dev stack | Closest-to-production browser testing |
| `npm run dev:recreate` | Rebuilds and recreates the Docker dev stack | Pick up Dockerfile/env/runtime changes |
| `npm run dev:down` | Stops the Docker dev stack | Cleanup |
| `npm run dev:docker:ps` | Shows Docker dev container status | Diagnostics |
| `npm run dev:docker:logs` | Streams Docker dev logs | Diagnostics |
| `npm run dev:local` | Starts API, web, and executor as local processes | Process-level debugging |
| `npm run dev:local:api` | Starts only the API locally | API debugging |
| `npm run dev:local:web` | Starts only the Vite web app locally | Frontend work |
| `npm run dev:local:executor` | Starts only the executor locally | Executor debugging |
| `npm run prod` | Starts the production-style Docker stack | Smoke-test deployment behavior |
| `npm run prod:prebuilt` | Pulls prebuilt images and starts without building | Fast deploy verification |
| `npm run prod:local-build` | Forces a local production image build | Test custom image changes |

## Environment loading

The root launcher scripts load env with `scripts/lib/dev-env.mjs`.

Current behavior:

- they look for `.env` first, then `.env.dev`
- if `.env` exists, `.env.dev` is ignored
- missing values get defaults for:
  - `RIVET_WORKSPACE_ROOT`
  - `RIVET_APP_DATA_ROOT`
  - `RIVET_RUNTIME_LIBRARIES_ROOT`
- if `RIVET_WORKFLOWS_HOST_PATH` or `RIVET_RUNTIME_LIBS_HOST_PATH` is present, the launcher resolves it to an absolute host path before invoking Docker Compose

## Local direct-process mode

`npm run dev:local` starts:

- API on `http://localhost:3100`
- Vite web app on `http://localhost:5174`
- executor websocket service on port `21889`

Important constraints:

- host Node must be `24+` for local API execution because the API now uses Node's built-in `node:sqlite`
- this mode does not recreate the nginx trusted-proxy layer, so it is best for service-level debugging rather than final end-to-end auth/routing validation
- Docker dev remains the best path for testing the full hosted browser flow exactly as deployed

## Docker dev behavior

`npm run dev` uses `ops/docker-compose.dev.yml`.

Current behavior:

- the browser entrypoint is still `http://localhost:8080` through nginx by default; override it with `RIVET_PORT` if needed
- the API is also exposed directly on `http://localhost:3100` for diagnostics
- the `web` service runs the Vite dev server inside the container with live bind mounts
- the `api` and `executor` services rebuild from Dockerfiles, so Node/runtime changes are picked up without a separate manual build step
- the launcher waits for healthy services; `RIVET_DOCKER_WAIT_TIMEOUT` controls the wait window

## Recording-storage notes

Workflow recordings use two persistence locations:

- compressed replay artifacts under the workflow root: `.recordings/`
- a SQLite index under `RIVET_APP_DATA_ROOT`: `recordings.sqlite`

For host-based API execution, that means the runtime must support `node:sqlite` (Node 24+). If your host Node version is older, use the Docker dev stack instead of `npm run dev:local`.

## Source of truth

- authored source lives under `wrapper/`, `ops/`, `scripts/`, and `docs/`
- `rivet/` is upstream source that can be replaced or refreshed
- generated build output should not be treated as authored source

## Safe verification workflow

For wrapper/API changes:

1. `npm --prefix wrapper/api test`
2. `npm --prefix wrapper/api run build`

For wrapper/web changes:

1. `npm --prefix wrapper/web run build`

For workflow-library mutations that change on-disk project state:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project in the left panel and run `Duplicate`
4. confirm the new project appears in the same folder with a `Copy` name and that the current selection/editor tab did not change

For workflow-library upload behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a folder in the left panel and run `Upload project`
4. choose a local `.rivet-project` file in the browser picker
5. note that some browsers may still show a generic picker instead of pre-filtering `.rivet-project`; selecting the wrong file type should fail cleanly without uploading anything
6. confirm the project appears in that folder
7. if the folder already contained that name, confirm the new file is saved as `Name 1`, `Name 2`, and so on
8. confirm the upload does not change the current selection, open a different tab, or expand folders automatically

For workflow-library download behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project in the left panel and run `Download`
4. for `unpublished`, confirm the browser downloads `Name [unpublished].rivet-project`
5. for `published`, confirm the browser downloads `Name [published].rivet-project`
6. for `unpublished_changes`, confirm the chooser appears and both saved versions download correctly
7. make unsaved editor changes and confirm downloads still reflect only the saved server-side versions
8. confirm the download flow does not change selection, open a different tab, or expand folders

For routing/auth/deployment changes:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
