# Development

See also: [Mistakes and Misconceptions](./mistakes-and-misconceptions.md)

## Setup commands

- `npm run setup`
  - ensures `wrapper/api` and `wrapper/web` dependencies exist
  - clones `rivet/` from the upstream repo if it is missing
  - installs upstream Yarn dependencies and builds `@ironclad/rivet-core` and `@ironclad/rivet-node` when needed
  - accepts either a Git checkout or a valid upstream snapshot already present in `rivet/`
- `npm run setup:rivet`
  - downloads the newest stable upstream Rivet tag into `./rivet`
  - use this when you want a clean versioned upstream snapshot for local Docker builds
  - `npm run setup:rivet -- --force` replaces an existing non-empty `rivet/` directory

## Main commands

| Command | What it does | Typical use |
|---|---|---|
| `npm run dev` | Starts the Docker dev stack | Closest-to-production browser testing |
| `npm run dev:recreate` | Rebuilds and recreates the Docker dev stack | Pick up Dockerfile/env/runtime changes |
| `npm run dev:docker:recreate` | Rebuilds and recreates the Docker dev stack without going through the alias | Useful when you want the exact script name that repo instructions refer to |
| `npm run dev:docker:config` | Renders the merged Docker dev Compose config without starting containers | Verify launcher/env/Compose wiring |
| `npm run dev:down` | Stops the Docker dev stack | Cleanup |
| `npm run dev:docker:ps` | Shows Docker dev container status | Diagnostics |
| `npm run dev:docker:logs` | Streams Docker dev logs | Diagnostics |
| `npm run dev:kubernetes-test` | Builds local images, deploys the local Kubernetes rehearsal stack, and starts a proxy port-forward | Most authentic local browser rehearsal against managed external services |
| `npm run dev:kubernetes-test:recreate` | Rebuilds images, recreates the local Kubernetes rehearsal namespace/release, and restarts the proxy port-forward | Reset the local Kubernetes rehearsal cleanly |
| `npm run dev:kubernetes-test:config` | Generates the local Kubernetes values file and renders the Helm manifest | Verify local Kubernetes launcher wiring without deploying |
| `npm run dev:kubernetes-test:ps` | Shows local Kubernetes rehearsal pods, deployments, statefulsets, and services | Diagnostics |
| `npm run dev:kubernetes-test:logs` | Streams logs for the local Kubernetes rehearsal release | Diagnostics |
| `npm run dev:kubernetes-test:down` | Stops the proxy port-forward and removes the local Kubernetes rehearsal release/namespace | Cleanup |
| `npm run dev:local` | Starts API, web, and executor as local processes | Process-level debugging |
| `npm run dev:local:api` | Starts only the API locally | API debugging |
| `npm run dev:local:web` | Starts only the Vite web app locally | Frontend work |
| `npm run dev:local:executor` | Starts only the executor locally | Executor debugging |
| `npm run prod` | Starts the production-style Docker stack | Smoke-test deployment behavior |
| `npm run prod:prebuilt` | Pulls prebuilt images and starts without building | Fast deploy verification |
| `npm run prod:prebuilt:recreate` | Recreates the prebuilt-image production stack from scratch | Verify the published artifact path cleanly |
| `npm run prod:local-build` | Forces a local production image build | Test custom image changes |
| `npm run prod:docker:recreate` | Rebuilds and recreates the production-style Docker stack without going through the alias | Useful when you want the exact script name that repo instructions refer to |
| `npm run prod:docker:config` | Renders the merged production-style Docker Compose config without starting containers | Verify launcher/env/Compose wiring |
| `npm run verify:filesystem` | Runs the repo-local compatibility baseline for single-host filesystem mode | Check that filesystem mode still has build/test and launcher-contract coverage |
| `npm run verify:filesystem:docker` | Verifies the filesystem Docker launcher shape with a disposable env/fixture root | Check that Docker launcher config still supports filesystem mode without managed services |
| `npm run verify:local-docker` | Verifies managed-storage local-Docker launcher shape with a disposable env/fixture root | Check that `managed + local-docker` still enables the expected Postgres/MinIO rehearsal path |
| `npm run verify:local-docker:split` | Runs split-topology repo-local checks plus local-Docker launcher validation | Check that split-era control/execution contracts still fit the local-Docker managed rehearsal model |
| `npm run verify:web-pure` | Runs the pure web helper tests with `tsx --test` | Catch regressions in extracted non-React dashboard/protocol helpers quickly |
| `npm run verify:kubernetes` | Runs the Kubernetes static-contract tests, renders the local rehearsal values path, and lint-renders the production overlay | Catch local/prod chart drift before handing the repo to operators |
| `npm --prefix wrapper/api run workflow-execution:measure -- --base-url http://localhost:8080 --endpoint hello-world --kind published --runs 5 --warmups 1` | Calls one published/latest workflow endpoint repeatedly and prints timing headers | Measure managed cold-hit vs warm-hit behavior safely |
| `npm run runtime-libraries:managed:audit` | Audits managed runtime-library release/job/object state and writes a JSON snapshot | Inspect live managed runtime-library state safely |
| `npm run runtime-libraries:managed:prune` | Builds a dry-run prune plan for managed runtime-library state | Review cleanup impact before applying it |
| `npm run ui:observe:install` | Installs Playwright Chromium for observable frontend runs | First-time browser setup |
| `npm run ui:observe` | Runs the headed slow-motion Playwright flow against the current hosted app | Watch the browser click through a real scenario |
| `npm run ui:observe:debug` | Runs the same flow with Playwright Inspector enabled | Step through or pause browser actions |
| `npm run ui:observe:report` | Opens the last Playwright HTML report | Review traces, screenshots, and videos after a run |

## Environment loading

The root launcher scripts load env with `scripts/lib/dev-env.mjs`.

Current behavior:

- they look for `.env` first, then `.env.dev`
- if `.env` exists, `.env.dev` is ignored
- if `RIVET_ENV_FILE` is set, the launchers and compatibility verification scripts use that explicit env file instead of `.env` / `.env.dev`
- missing values get defaults for:
  - `RIVET_WORKSPACE_ROOT`
  - `RIVET_APP_DATA_ROOT`
  - `RIVET_RUNTIME_LIBRARIES_ROOT`
- if `RIVET_ARTIFACTS_HOST_PATH` is present, the launcher resolves it to an absolute host path and derives:
  - `RIVET_WORKFLOWS_HOST_PATH=<artifactsRoot>/workflows`
  - `RIVET_RUNTIME_LIBS_HOST_PATH=<artifactsRoot>/runtime-libraries`
- if `RIVET_WORKFLOWS_HOST_PATH` or `RIVET_RUNTIME_LIBS_HOST_PATH` is present, the launcher resolves it to an absolute host path before invoking Docker Compose
- explicit `RIVET_WORKFLOWS_HOST_PATH` and `RIVET_RUNTIME_LIBS_HOST_PATH` values override the derived paths from `RIVET_ARTIFACTS_HOST_PATH`

Operational note:

- `RIVET_ARTIFACTS_HOST_PATH` is the primary public filesystem-mode contract
- `RIVET_WORKFLOWS_HOST_PATH` and `RIVET_RUNTIME_LIBS_HOST_PATH` remain compatibility overrides for the launcher
- `RIVET_STORAGE_MODE=managed` switches both workflows and runtime libraries to managed Postgres plus object storage; in that mode `RIVET_RUNTIME_LIBRARIES_ROOT` remains only a local cache/workspace
- optional managed runtime-library readiness tuning uses:
  - `RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS`
- split-topology launches can also override:
  - `RIVET_API_PROFILE=combined|control|execution`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint|editor|none`
  - `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=true|false`

## Compatibility matrix

The non-cluster compatibility modes that should keep working are:

| Storage/runtime shape | Support status | What it is for | What must be true |
|---|---|---|---|
| `filesystem + combined` | Supported | Primary backward-compatible single-host operation | Local workflow tree and runtime-library root remain authoritative |
| `filesystem + control` | Supported | Secondary control-plane-only debugging and admin validation | Control-plane/admin/latest routes still boot without managed services |
| `filesystem + execution` | Unsupported by design | None | `RIVET_API_PROFILE=execution` must fail fast unless storage mode is `managed` |
| `managed + local-docker + combined` | Supported | Existing Postgres/MinIO rehearsal path through Docker dev or production-style Docker | Docker launchers must auto-enable `workflow-managed` |
| `managed + local-docker + control/execution` | Supported through repo-local split validation and local dependency rehearsal | Split-era compatibility checks without Kubernetes | Split route/profile contracts must stay valid while storage still uses local Docker Postgres/MinIO |

Compatibility rules:

- `filesystem` compatibility is single-host only
- `local-docker` means `RIVET_STORAGE_MODE=managed` with `RIVET_DATABASE_MODE=local-docker`
- Docker combined-mode rehearsal is necessary but not sufficient to prove the real split runtime shape
- the repo-local split verification command proves the control-plane versus execution-plane contract; live Kubernetes validation is still required for real in-cluster routing and scaling behavior

## Local Kubernetes launcher

The repo now includes a local Kubernetes rehearsal launcher:

- `npm run dev:kubernetes-test`
- `npm run dev:kubernetes-test:recreate`
- `npm run dev:kubernetes-test:down`
- `npm run dev:kubernetes-test:config`
- `npm run dev:kubernetes-test:ps`
- `npm run dev:kubernetes-test:logs`
- `npm run verify:kubernetes`

Current behavior:

- it builds local `proxy`, `web`, `api`, and `executor` images from the current workspace
- it deploys the real Helm chart into a dedicated local namespace
- it targets `RIVET_K8S_CONTEXT` explicitly without mutating your global `kubectl` current-context
- on Docker-backed local clusters such as Docker Desktop Kubernetes, it imports the freshly built images into the cluster nodes automatically
- it keeps `web=1`
- it keeps `backend=1`
- it scales the legitimate local rehearsal targets:
  - `proxy`
  - `execution`
- it creates Kubernetes secrets from the canonical managed-service envs already used by the app:
  - `RIVET_KEY`
  - `RIVET_DATABASE_CONNECTION_STRING`
  - `RIVET_STORAGE_URL` or the explicit `RIVET_STORAGE_*` tuple
  - `RIVET_STORAGE_ACCESS_KEY_ID`
  - `RIVET_STORAGE_ACCESS_KEY`
- it starts a local `kubectl port-forward` for the proxy service so the app is available on `http://127.0.0.1:${RIVET_K8S_PROXY_PORT:-RIVET_PORT:-8080}`
- the proxy startup normalizes `RIVET_PROXY_RESOLVER` so Kubernetes DNS service hostnames resolve to the IPs nginx expects

Operational notes:

- this launcher is for the supported Kubernetes topology only:
  - `proxy>=2`
  - `web=1`
  - `backend=1`
  - `execution>=2`
- the scalable tiers do not grow in fixed pairs:
  - a new `execution` pod is only another execution-plane API pod
  - a new `proxy` pod is only another nginx proxy pod
- for endpoint-heavy load, `execution` is the primary scale target and `proxy` is the secondary ingress tier
- it is intentionally opinionated toward external managed Postgres plus external S3 or S3-compatible storage
- it does not replace the production chart or create a second deployment contract; it is a local wrapper around the same chart the real deployment should use
- by default it expects the Docker Desktop Kubernetes context `docker-desktop`
- optional launcher-specific overrides are:
  - `RIVET_K8S_CONTEXT`
  - `RIVET_K8S_CLUSTER_DOMAIN`
  - `RIVET_K8S_NAMESPACE`
  - `RIVET_K8S_RELEASE`
  - `RIVET_K8S_PROXY_PORT`
  - `RIVET_K8S_PROXY_REPLICAS`
  - `RIVET_K8S_WEB_REPLICAS`
  - `RIVET_K8S_EXECUTION_REPLICAS`
  - `RIVET_K8S_LOAD_LOCAL_IMAGES`

For the operator-facing chart contract and handoff checklist, see:

- [Kubernetes](./kubernetes.md)

For the full operator checklist and manual equivalent, see the root runbook:

- [Local Kubernetes Rehearsal for Scaled Execution + Latest Debugger](../Local%20Kubernetes%20Rehearsal%20for%20Scaled%20Execution%20%2B%20Latest%20Debugger.md)

## Observable Playwright flow

The repo now includes a headed Playwright workflow for frontend debugging and demos where you want to watch the browser actions live.

Current behavior:

- `npm run ui:observe` launches Chromium in headed mode with `slowMo`, trace capture, video capture, and HTML reporting enabled
- the runner loads the same `.env` / `.env.dev` file as the Docker scripts, so UI-gated hosts automatically reuse `RIVET_KEY`
- unless `PLAYWRIGHT_BASE_URL` is already set, the runner targets `http://127.0.0.1:${RIVET_PORT}` from your env file, defaulting to `8080`
- the current observable spec opens the first project in the first workflow folder, then visibly exercises the hosted editor focus/clipboard recovery path
- trace, video, screenshots, and the HTML report are written under `artifacts/playwright/`

Managed-state safety:

- most browser-visible specs should stay non-mutating and prefer mocked API responses when the behavior under test is modal/controller/UI wiring rather than storage persistence
- mutating workflow specs are blocked against `RIVET_STORAGE_MODE=managed` unless `PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS=1` is set explicitly
- shared Playwright workflow helpers use Playwright's request context for setup and cleanup, not `page.evaluate(fetch(...))`, so they go through the same proxy-auth path as the real browser shell
- if a mutating spec creates real workflow state in managed mode, it is responsible for explicit cleanup before the run finishes

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
- this mode does not recreate the nginx trusted-proxy layer
- the Vite dev server only proxies `/api/*` to the API and `/ws/executor*` to the executor
- Vite does not proxy the published/latest workflow route families, `/ui-auth`, or `/ws/latest-debugger`, and it does not inject the trusted proxy headers that those control-plane routes expect
- use it for service-level debugging, direct API/executor work, or frontend iteration that does not rely on fully wired hosted-shell control-plane routing
- Docker dev remains the best path for testing the full hosted browser flow exactly as deployed

## Docker launcher behavior

The Docker launchers now render layered Compose files:

- `npm run dev` / `npm run dev:docker:*` use `ops/docker-compose.managed-services.yml` plus `ops/docker-compose.dev.yml`
- `npm run prod` / `npm run prod:docker:*` use `ops/docker-compose.managed-services.yml` plus `ops/docker-compose.yml`
- the shared file only contributes the managed Postgres/MinIO services, and the launcher auto-enables the `workflow-managed` profile only when `RIVET_STORAGE_MODE=managed`

Current behavior:

- the browser entrypoint is still `http://localhost:8080` through nginx by default; override it with `RIVET_PORT` if needed
- the API is also exposed directly on `http://localhost:3100` for diagnostics
- the local Docker stacks keep `RIVET_API_PROFILE=combined` by default, so `/api/*`, `${RIVET_LATEST_WORKFLOWS_BASE_PATH}`, and `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` all land on the same `api` container there
- the `web` service runs the Vite dev server inside the container with live bind mounts
- the `api` and `executor` services rebuild from Dockerfiles, so Node/runtime changes are picked up without a separate manual build step
- the launcher waits for healthy services; `RIVET_DOCKER_WAIT_TIMEOUT` controls the wait window
- in `RIVET_STORAGE_MODE=managed`, both workflow state and runtime-library releases come from managed services, while `/data/runtime-libraries` remains only an extracted local cache/workspace inside each container
- in `RIVET_STORAGE_MODE=managed`, published/latest endpoint execution also keeps API-local warm caches for endpoint pointers and immutable revision contents; the first hit after startup or after a workflow mutation can still be slower, but repeated hits for the same unchanged trivial workflow should settle onto the warm local path
- a later cleanup pass did not change that behavior; it extracted the managed execution invalidation/service code, replaced brittle source assertions with behavioral tests, added a measurement tool, and hardened listener startup/shutdown plus same-process self-notify handling without changing the public execution contract
- if `RIVET_DATABASE_MODE=managed`, runtime-library replica-status rows also live in the shared Postgres database, so stale rows from older containers can survive a Docker recreate until retention cleanup runs or you clear them explicitly
- when the Runtime Libraries modal shows stale rows that are only historical dev noise, use the `Clear stale replicas` action or call `POST /api/runtime-libraries/replicas/cleanup`
- set `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true` when you want additive managed execution timing headers for local diagnosis of endpoint resolve/materialize/execute stages
- local Docker still does not prove multi-backend latest-debugger support; the supported Kubernetes contract is a singleton control-plane backend plus independently scalable execution replicas

## Recording-storage notes

Workflow recordings use two persistence locations:

- in `filesystem` mode:
  - compressed replay artifacts under the workflow root: `.recordings/`
  - a SQLite index under `RIVET_APP_DATA_ROOT`: `recordings.sqlite`
- in `managed` mode:
  - recording metadata rows in Postgres
  - recording and replay artifacts in managed object storage

For host-based API execution, filesystem-mode recording persistence still requires `node:sqlite` (Node 24+). If your host Node version is older, use the Docker dev stack instead of `npm run dev:local`.

## Source of truth

- authored source lives under `wrapper/`, `ops/`, `scripts/`, and `docs/`
- hosted editor patches that must survive production image builds should live under `wrapper/web/overrides/`, `wrapper/web/dashboard/`, or other tracked wrapper files
- `rivet/` is upstream source that can be replaced or refreshed and should be treated as read-only input for this repo
- generated build output should not be treated as authored source

## Internal ownership boundaries

When adding new code, keep the post-refactor ownership seams explicit instead of rebuilding large mixed-responsibility files:

- workflow-managed backend code goes under `wrapper/api/src/routes/workflows/managed/`
  - `backend.ts` is the facade/composition root
  - DB retry/query helpers stay in `db.ts`
  - transaction sequencing stays in `transactions.ts`
  - row mapping stays in `mappers.ts`
- filesystem recording compatibility code stays under `wrapper/api/src/routes/workflows/`
  - keep `recordings.ts` as the public orchestrator
  - keep artifact IO in `recordings-artifacts.ts`
  - keep metadata normalization in `recordings-metadata.ts`
  - keep index/cleanup/delete maintenance in `recordings-maintenance.ts`
  - keep queue/readiness state in `recordings-store.ts`
- managed runtime-library orchestration goes under `wrapper/api/src/runtime-libraries/managed/`
  - keep `backend.ts` as the facade
  - keep job persistence, SSE streaming, worker flow, process tracking, and replica cleanup in their focused modules
- workflow/filesystem compatibility code should stay obvious in `wrapper/api/src/routes/workflows/storage-backend.ts`
  - do not hide `filesystem` versus `managed` behavior behind a generic abstraction layer
- dashboard controllers belong in `wrapper/web/dashboard/`
  - `useWorkflowLibraryController.ts`, `useRunRecordingsController.ts`, `useProjectSettingsActions.ts`, `useDashboardSidebar.ts`, and `useEditorBridgeEvents.ts` should own orchestration
  - keep project-settings validation and labels in `projectSettingsForm.ts`
  - keep run-recordings modal shell logic in `RunRecordingsModal.tsx` and its focused UI slices in `RecordingWorkflowSelect.tsx` and `RecordingRunsTable.tsx`
  - keep `RuntimeLibrariesModal.tsx` as the shell, `useRuntimeLibrariesModalState.ts` as the public controller, and `runtimeLibrariesJobStream.ts` as the SSE/log-state helper layer
  - page/components should stay mostly render wiring
- dashboard/editor bridge wiring should stay explicit
  - `DashboardPage.tsx` is the composition root
  - `useEditorCommandQueue.ts` owns pre-ready command buffering
  - `useEditorBridgeEvents.ts` owns dashboard-side message listeners and cross-iframe save shortcut capture
  - `EditorMessageBridge.tsx` owns editor-side message handling
- remote debugger/executor transport code belongs in `wrapper/web/overrides/hooks/`
  - keep exported hooks thin over `remoteDebuggerClient.ts`, `remoteDebuggerDatasets.ts`, `remoteExecutorProtocol.ts`, and `remoteExecutionSession.ts`
- Kubernetes template reuse should stay shallow
  - use `_env.tpl` and `_pod.tpl` for genuinely repeated backend/execution blocks
  - keep `proxy` and `web` explicit unless extraction clearly improves readability

## Safe verification workflow

For wrapper/API changes:

1. `npm --prefix wrapper/api test`
2. `npm --prefix wrapper/api run build`

Current repo-local baseline:

- CI also runs the same `wrapper/api` build and test steps directly before image packaging.
- CI also lint-renders the Helm chart with real image repository overrides and verifies the key negative cases:
  - placeholder image repositories are rejected
  - published-route-prefix overrides are rejected
  - the managed-only chart shape is enforced
- managed migration verification now has direct regression coverage for its comparison logic, but real import/cutover confidence still requires the managed Docker rehearsal described below.

For wrapper/web changes:

1. `npm --prefix wrapper/web run build`
2. if the change adds or changes pure helper logic under `wrapper/web/dashboard/` or `wrapper/web/overrides/hooks/`, run `npm run verify:web-pure`
3. if the change affects browser-visible behavior, run `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0`, then `node scripts/playwright-observe.mjs test`
4. if the Playwright coverage needs real workflow mutations in `RIVET_STORAGE_MODE=managed`, set `PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS=1` deliberately and keep cleanup explicit; prefer mocked API/browser tests for modal and controller coverage when storage mutation is not the point
5. if the change lives under `wrapper/web/overrides/` or affects hosted editor save/hotkey behavior, also verify with `npm run prod:local-build`; `npm run prod` may pull already-published images instead of using your local workspace changes

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

For workflow-library folder creation behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. click `+ New folder` at the bottom of the workflow library
4. enter a folder name when prompted
5. confirm the new folder appears at the root level of the tree
6. try an existing root-level name and confirm the UI shows the API conflict instead of silently overwriting anything

For workflow-library folder rename behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a folder in the left panel and run `Rename folder`
4. enter a new folder name when prompted
5. confirm the folder remains in the tree under the new name
6. if the folder contained projects that are open in the editor, confirm those tabs still point at the renamed paths and save correctly afterward
7. try renaming to an existing sibling folder name and confirm the UI shows the API conflict

For workflow-library folder deletion behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click an empty folder in the left panel and run `Delete folder`
4. confirm the UI asks for confirmation before deletion
5. confirm the folder disappears only after confirming
6. right-click a non-empty folder and confirm the `Delete folder` action is disabled
7. if you call the API directly for a non-empty folder, confirm it still rejects with `Only empty folders can be deleted`

For workflow-library drag/drop move behavior:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. drag a project from one folder to another and confirm the tree updates after the drop
4. if that project is open in the editor, confirm saves still target the new path after the move
5. drag a folder into another folder and confirm all nested projects move with it
6. drag a project or folder back to the root area and confirm it is reparented to the root
7. try to drag a folder into itself or one of its descendants and confirm the move is rejected cleanly

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
5. if you are in `managed` mode, also confirm the saved revision id does not change on that no-op save
6. then make a real saved change, save again, and confirm the sidebar updates to `Unpublished changes`

For routing/auth/deployment changes:

1. `npm run dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`

For the current Helm chart and images:

1. keep `replicaCount.proxy>=2` and let proxy autoscaling absorb ingress pressure from public endpoint traffic
2. keep `replicaCount.web=1` unless real dashboard/editor traffic becomes significant
3. keep `replicaCount.backend=1`
4. keep `autoscaling.backend.enabled=false`
5. keep `workflowStorage.backend=managed` and `runtimeLibraries.backend=managed`
6. keep `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH=/workflows` and `RIVET_LATEST_WORKFLOWS_BASE_PATH=/workflows-latest`
7. set `env.RIVET_PROXY_RESOLVER` for in-cluster nginx DNS resolution
8. provide `RIVET_KEY` through `auth.keySecretName` or Vault, even if the optional UI gate and public workflow bearer checks are disabled
9. keep the control-plane API on `RIVET_API_PROFILE=control` and the execution Deployment on `RIVET_API_PROFILE=execution`
10. keep control-plane runtime-library reporting at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=none`
11. keep execution-plane runtime-library reporting at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint` with `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=false`
12. if Vault is enabled, make sure the injected `/vault/dotenv` carries the required managed Postgres/object-storage env vars before relying on it instead of Kubernetes secret refs
13. do not scale `proxy` and `execution` as if they were a fixed pair; they are separate deployments with separate pressure profiles
14. define concrete CPU and memory requests for at least `resources.proxy` and `resources.execution` before treating the CPU-based HPAs as production-ready

For managed endpoint latency and cache behavior:

1. run in `RIVET_STORAGE_MODE=managed`
2. call the same trivial published or latest endpoint twice
3. expect the first request after startup or after a publish/save/rename/move to be the cold path
4. expect the second request for the same unchanged workflow to drop onto the warm local path
5. if you enabled `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true`, confirm `x-workflow-cache` moves from `miss` to `hit` and inspect `x-workflow-resolve-ms` / `x-workflow-materialize-ms`

For managed endpoint measurement with the dedicated script:

1. run the app in `RIVET_STORAGE_MODE=managed`
2. optionally set `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true` so the route emits stage timings
3. run `npm --prefix wrapper/api run workflow-execution:measure -- --base-url http://localhost:8080 --endpoint hello-world --kind published --runs 5 --warmups 1`
4. expect one output line per request with HTTP status, client duration, `x-duration-ms`, `x-workflow-resolve-ms`, `x-workflow-materialize-ms`, `x-workflow-execute-ms`, and `x-workflow-cache`
5. if debug headers are disabled, expect those per-stage fields to print as `n/a` rather than failing
6. use the transition from `x-workflow-cache=miss` to `x-workflow-cache=hit` to verify cold-first-hit then warm-hit behavior

For the current execution-plane split specifically:

1. keep the control plane conservative and scale the execution Deployment instead of the backend StatefulSet
2. keep the proxy Deployment redundant because every published endpoint call still crosses it
3. treat `execution` as the primary endpoint-throughput scale boundary and `proxy` as a separate ingress tier rather than a one-for-one partner
4. confirm `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` reaches the execution-plane API while `${RIVET_LATEST_WORKFLOWS_BASE_PATH}` still reaches the control-plane API
5. confirm `/api/*` and `POST /__rivet_auth` still reach the control-plane API
6. confirm `/internal/workflows/:endpointName` is not exposed through nginx and is only reachable inside the cluster
7. confirm runtime-library `Endpoint execution` readiness reflects execution-plane API replicas, not control-plane API replicas

## Validation boundaries

Use the three validation layers intentionally:

- repo-local:
  - proves API correctness, cache/invalidation behavior, config parsing, proxy/chart static contracts, and most workflow/runtime-library backend logic
  - this is where `npm --prefix wrapper/api run build`, `npm --prefix wrapper/api test`, and Helm lint/template checks belong
- managed Docker rehearsal:
  - proves managed-state behavior against disposable Postgres plus object storage
  - use this for workflow-storage migration rehearsal, `workflow-storage:verify`, managed endpoint measurement, hosted browser flows, and runtime-library install/remove/readiness checks
  - the current Docker stacks still run the API in the `combined` profile, so they do not prove the real control-plane versus execution-plane split by themselves even though the route families are still exposed at their normal published/latest paths
- live Kubernetes validation:
  - proves the real split topology, ingress/proxy behavior, control-plane versus execution-plane routing, restart boundaries, and execution scaling
  - do not treat chart render success or Docker rehearsal as a substitute for this layer when the question is about real in-cluster behavior

Current follow-up expectations:

- if a change touches migration, cutover, or recording durability, run the managed Docker rehearsal instead of trusting repo-local proof alone
- if a change touches runtime-library readiness UI, prefer adding direct UI coverage and still validate the modal against the managed stack because backend aggregation tests do not fully prove the rendered browser state
- if a change touches the control-plane versus execution-plane boundary, finish with live Kubernetes validation in an isolated namespace

## Compatibility verification commands

Use the current compatibility commands intentionally:

- `npm run verify:filesystem`
  - runs the repo-local baseline for filesystem compatibility:
    - `wrapper/api` build
    - `wrapper/api` tests
    - filesystem launcher/profile contract assertions
- `npm run verify:filesystem:docker`
  - creates a disposable filesystem fixture root and explicit env file
  - verifies the Docker launchers can render `config` for filesystem mode without managed-service activation
- `npm run verify:local-docker`
  - creates a disposable managed rehearsal env file
  - verifies `managed + local-docker` activates the `workflow-managed` launcher profile
  - verifies the Docker launchers can render `config` for that rehearsal shape
- `npm run verify:local-docker:split`
  - reruns the split-topology repo-local assertions for API profiles, proxy/chart contracts, runtime-library tier ownership, and storage config
  - then verifies the local-Docker launcher contract for the managed rehearsal path

These commands do not replace full browser-level or live-cluster validation:

- use the managed Docker rehearsal for migration/import, hosted editor parity, runtime-library install/remove/readiness checks, and endpoint measurement
- use Kubernetes for real split-topology routing, restart, and scaling proof
