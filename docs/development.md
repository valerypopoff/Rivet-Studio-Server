# Development

See also: [Mistakes and Misconceptions](./mistakes-and-misconceptions.md)

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
| `npm run ui:observe:install` | Installs Playwright Chromium for observable frontend runs | First-time browser setup |
| `npm run ui:observe` | Runs the headed slow-motion Playwright flow against the current hosted app | Watch the browser click through a real scenario |
| `npm run ui:observe:debug` | Runs the same flow with Playwright Inspector enabled | Step through or pause browser actions |
| `npm run ui:observe:report` | Opens the last Playwright HTML report | Review traces, screenshots, and videos after a run |

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

## Observable Playwright flow

The repo now includes a headed Playwright workflow for frontend debugging and demos where you want to watch the browser actions live.

Current behavior:

- `npm run ui:observe` launches Chromium in headed mode with `slowMo`, trace capture, video capture, and HTML reporting enabled
- the runner loads the same `.env` / `.env.dev` file as the Docker scripts, so UI-gated hosts automatically reuse `RIVET_KEY`
- unless `PLAYWRIGHT_BASE_URL` is already set, the runner targets `http://127.0.0.1:${RIVET_PORT}` from your env file, defaulting to `8080`
- the current observable spec opens the first project in the first workflow folder, then visibly exercises the hosted editor focus/clipboard recovery path
- trace, video, screenshots, and the HTML report are written under `artifacts/playwright/`

Typical usage:

1. start the app you want to watch, for example `npm run dev` or `npm run prod:local-build`
2. if this is the first Playwright run on the machine, run `npm run ui:observe:install`
3. run `npm run ui:observe`
4. if you want the Playwright Inspector alongside the browser, run `npm run ui:observe:debug`
5. after the run, open `npm run ui:observe:report`

Windows PowerShell override example:

1. `$env:PLAYWRIGHT_BASE_URL='http://127.0.0.1:8086'`
2. `$env:PLAYWRIGHT_SLOW_MO='500'`
3. `npm run ui:observe`

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
- hosted editor patches that must survive production image builds should live under `wrapper/web/overrides/`, `wrapper/web/dashboard/`, or other tracked wrapper files
- `rivet/` is upstream source that can be replaced or refreshed and should be treated as read-only input for this repo
- generated build output should not be treated as authored source

## Safe verification workflow

For wrapper/API changes:

1. `npm --prefix wrapper/api test`
2. `npm --prefix wrapper/api run build`

For wrapper/web changes:

1. `npm --prefix wrapper/web run build`
2. if the change affects editor focus, keyboard shortcuts, or iframe interaction, run `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0`, then `node scripts/playwright-observe.mjs test`
3. if the change lives under `wrapper/web/overrides/` or affects hosted editor save/hotkey behavior, also verify with `npm run prod:local-build`; `npm run prod` may pull already-published images instead of using your local workspace changes

For workflow-library mutations that change on-disk project state:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project in the left panel and run `Duplicate`
4. for `unpublished`, confirm the new project appears in the same folder as `Name [unpublished] Copy.rivet-project` and that the current selection/editor tab did not change
5. for `published`, confirm duplication uses the published snapshot and names the duplicate `Name [published] Copy.rivet-project`
6. for `unpublished_changes`, confirm the chooser appears and both saved versions duplicate correctly, including the expected `Name [published] Copy.rivet-project` vs `Name [unpublished changes] Copy.rivet-project` naming
7. confirm duplication still leaves the current selection/editor tab unchanged

For workflow-library project creation behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a folder in the left panel and run `Create project`
4. enter a new project name when prompted
5. confirm the folder expands and the new project opens in the editor
6. confirm there is no inline `+` create-project button on folder rows anymore
7. try an existing name in the same folder and confirm the UI shows the API conflict instead of silently overwriting the file

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

For workflow-library project deletion behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click an `unpublished` project in the left panel and run `Delete project`
4. confirm the context-menu action only opens Project Settings and does not delete immediately
5. confirm the project is deleted only after clicking `Delete project` again inside Project Settings
6. right-click a `published` or `unpublished_changes` project and run `Delete project`
7. confirm the UI shows `To delete a project, unpublish it first`
8. confirm the guarded delete action does not change selection, open a different tab, or delete anything directly from the context menu

For workflow-library project rename entry behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project in the left panel and run `Rename project`
4. confirm the context-menu action opens Project Settings for that project instead of renaming immediately
5. confirm the rename still completes only through the existing Project Settings flow
6. confirm the menu action does not change the current selection or open a different project on its own

For hosted editor keyboard-node behavior:

1. `npm run dev`
2. validate through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. open a workflow in the editor iframe and confirm the workflow-library row that opened it does not keep the visible browser focus outline
4. confirm the editor iframe receives keyboard focus after open without showing a visible white perimeter
5. click a node normally and confirm `Ctrl+C` then `Ctrl+V` duplicates it through the internal node clipboard
6. deliberately return focus to the workflow library, then confirm `Shift+click` multi-selection inside the editor reclaims iframe focus and still copies multiple nodes
7. deliberately return focus to the workflow library, then click blank canvas background and confirm `Ctrl+C` / `Ctrl+V` work again without an extra recovery click on a node
8. open and close an editor context menu or search UI, then confirm `Ctrl+C` and `Ctrl+V` still work after returning to the canvas
9. confirm `Ctrl+S` works while focus is inside the workflow iframe, including on Windows browsers
10. confirm the browser can still type normally inside real text inputs and that copy/paste/save shortcuts do not hijack active editor form fields

For hosted editor production-image regressions:

1. remember that `npm run prod` prefers pulled images, while `npm run prod:local-build` uses your current workspace
2. if dev works but prod does not, diff the behavior against clean upstream `rivet` and move any hosted-only patch into tracked wrapper code before trusting the local result
3. for clipboard regressions specifically, check the tracked hosted overrides for `useCopyNodesHotkeys`, `useContextMenu`, and the canvas focus handoff in `EditorMessageBridge.tsx`

For published-project save status behavior:

1. `npm run dev`
2. validate through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. publish a workflow project
4. save it with no actual changes and confirm the sidebar stays `Published` without a brief `Unpublished changes` flicker
5. then make a real saved change, save again, and confirm the sidebar updates to `Unpublished changes`

For routing/auth/deployment changes:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
