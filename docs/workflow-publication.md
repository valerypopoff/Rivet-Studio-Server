# Workflow Publication

Workflows can be published as HTTP endpoints. This document describes the current publication, execution, and recording model.

## Concepts

- **Project file** (`*.rivet-project`): the live, editable workflow file
- **Settings sidecar** (`*.rivet-project.wrapper-settings.json`): stores the endpoint draft plus publication state
- **Published snapshot** (`.published/<snapshotId>.rivet-project`): frozen copy of the project at publish time
- **Dataset sidecar** (`*.rivet-data`): optional data associated with a project, published alongside it
- **Execution recording bundle** (`.recordings/<workflowId>/<recordingId>/`): replayable snapshot of one endpoint execution
- **Recording index** (`<RIVET_APP_DATA_ROOT>/recordings.sqlite`): SQLite metadata index used for listing, pagination, retention, and artifact lookup

Projects live under the workflow root configured by `RIVET_WORKFLOWS_ROOT` in the API container and backed by `RIVET_WORKFLOWS_HOST_PATH` on the host in Docker modes.

Published snapshots and recording bundles both live inside that same workflow tree.
The metadata index is separate: it lives under `RIVET_APP_DATA_ROOT` as `recordings.sqlite`.

## Stored settings model

The settings sidecar stores five publication-related fields:

- `endpointName`
  - the editable draft endpoint name shown in the UI
- `publishedEndpointName`
  - the endpoint name currently exposed by the public routes
- `publishedSnapshotId`
  - the snapshot ID under `.published/`
- `publishedStateHash`
  - SHA-256 of `endpointName + project file + dataset state` at publish time
- `lastPublishedAt`
  - ISO timestamp of the last successful publish operation

Important current behavior:

- publishing updates both `endpointName` and `publishedEndpointName`
- publishing also updates `lastPublishedAt`
- unpublishing clears only the `published*` fields and keeps `endpointName` as the saved draft/default
- unpublishing keeps `lastPublishedAt`, so the UI can still show when the project was last published once it becomes published again
- endpoint lookup is case-insensitive, but the stored/public casing is preserved

## Status model

Each project has a derived status:

| Status | Meaning |
|---|---|
| `unpublished` | No published endpoint is currently active |
| `published` | The live file matches the published snapshot/hash |
| `unpublished_changes` | An endpoint is published, but the live file has diverged from the published state |

Status is derived from the stored settings plus a fresh state hash; it is not stored as the source of truth.

The dashboard does not maintain its own separate optimistic publication-status model after save. It refreshes `/api/workflows/tree` and uses the API's derived status.

In Project Settings:

- `Published` and `Unpublished changes` show `Last published at ...`
- `Unpublished` does not show that line
- older already-published projects that predate the explicit `lastPublishedAt` field fall back to the settings-sidecar file timestamp

## Publish flow

1. User sets an endpoint name and clicks `Publish`.
2. Server validates the name:
   - non-empty
   - letters, numbers, and hyphens only
   - unique across all workflow projects, case-insensitively
3. Server computes a SHA-256 hash of `endpointName + project file + dataset state`.
4. Server writes or overwrites `.published/<snapshotId>.rivet-project` and its dataset sidecar.
5. Server writes the settings sidecar with `endpointName`, `publishedEndpointName`, `publishedSnapshotId`, `publishedStateHash`, and `lastPublishedAt`.

If the project has already been published before, the current implementation reuses the existing `publishedSnapshotId` instead of generating a new one.

## Save flow after publish

1. User saves the project in the editor.
2. The editor writes the updated project file and dataset sidecar.
3. The editor emits `project-saved`.
4. The dashboard refreshes `/api/workflows/tree`.
5. The sidebar updates from the API's derived status.

That means:

- saving a published project with real saved changes transitions to `unpublished_changes` once the refresh returns
- saving a published project with no actual saved changes stays `published` and does not briefly flicker to `unpublished_changes`

## Unpublish flow

1. Server deletes the published snapshot and its dataset sidecar.
2. Server clears `publishedEndpointName`, `publishedSnapshotId`, and `publishedStateHash`.
3. Server keeps `endpointName` in the settings sidecar as the saved draft endpoint name.

In the current dashboard UI, the project-row context menu exposes `Rename project`, `Download`, `Duplicate`, and `Delete project`.

- `Rename project` opens Project Settings for that workflow and reuses the existing rename flow there

`Delete project` is still guarded:

- for `unpublished` projects, clicking it opens Project Settings and the user must click `Delete project` there to complete deletion
- for `published` or `unpublished_changes` projects, the dashboard shows a toast telling the user to unpublish first

The API delete route itself still handles cleanup even if called directly for a published project.

## Project creation

Projects can now also be created inside workflow folders from the folder-row context menu or through:

- `POST /api/workflows/projects`

Current creation behavior:

- folder-level project creation currently exists only in the folder-row context menu's `Create project` action
- the dashboard prompts for a new project name and posts that name plus the target folder path to the API
- the server writes a new blank `.rivet-project` file in the selected folder and returns it as a normal unpublished workflow project
- after successful creation, the dashboard expands the folder, refreshes the tree, and opens the new project in the editor
- unlike upload/duplicate/download, creation is intentionally disruptive to the current editor session because opening the new project is part of the UX
- if the folder already contains that exact project name, the API returns `409` instead of auto-numbering or overwriting

## Project duplication

Projects can now be duplicated from the workflow tree's project-row context menu or through:

- `POST /api/workflows/projects/duplicate`

Current duplication behavior:

- the duplicate is created in the same folder as the source project
- `POST /api/workflows/projects/duplicate` now accepts `{ "relativePath": string, "version"?: "live" | "published" }`
- duplicate names use the same saved-version tag model as downloads:
  - `Name [unpublished] Copy`
  - `Name [published] Copy`
  - `Name [unpublished changes] Copy`
- if that exact duplicate stem already exists in the folder, the API numbers it as `... Copy 1`, `... Copy 2`, and so on
- duplicating an already duplicated project stays literal, so `Name [unpublished] Copy` becomes `Name [unpublished] Copy [unpublished] Copy` before numbered variants are needed
- for `unpublished`, the dashboard duplicates the saved live file immediately
- for `published`, the dashboard duplicates the published snapshot immediately
- for `unpublished_changes`, the dashboard opens a chooser so the user can duplicate either the published snapshot or the saved live file with unpublished changes
- the server loads the chosen saved source version, assigns a fresh `project.metadata.id`, updates `project.metadata.title` to the generated duplicate name, and serializes a brand-new `.rivet-project` file
- the duplicate is therefore an independent workflow project, not a filesystem clone that still shares the original project ID
- the dashboard refreshes the tree after duplication but does not auto-select, auto-open, auto-expand folders, highlight, or otherwise change the current editor session

What duplication does **not** copy:

- the settings sidecar (`*.wrapper-settings.json`)
- the dataset sidecar (`*.rivet-data`)
- published snapshots under `.published/`
- execution recordings under `.recordings/`

That means a duplicated published project starts as a normal unpublished workflow with no endpoint draft, no published endpoint, no snapshot, and no copied recording history.

## Project uploading

Projects can now also be uploaded into workflow folders from the folder-row context menu or through:

- `POST /api/workflows/projects/upload`

Current upload behavior:

- the custom upload action currently exists only on folder rows
- the dashboard opens a browser file picker and reads the chosen `.rivet-project` file locally before sending it to the API
- some browsers do not reliably pre-filter Rivet's custom `.rivet-project` extension in that picker, so the dashboard validates the selected filename after picking and the API validates it again
- the server parses the uploaded project, assigns a fresh `project.metadata.id`, updates `project.metadata.title` to the final saved name, and writes a brand-new `.rivet-project` file into the selected folder
- name collisions are resolved as `Name`, then `Name 1`, `Name 2`, and so on
- the uploaded project starts as a normal unpublished workflow because only the project file is imported
- the dashboard refreshes the tree after upload but does not auto-select, auto-open, auto-expand folders, highlight, or otherwise change the current editor session

What upload does **not** copy:

- the source machine's settings sidecar (`*.wrapper-settings.json`)
- the source machine's dataset sidecar (`*.rivet-data`)
- published snapshots under `.published/`
- execution recordings under `.recordings/`

## Project downloading

Projects can now also be downloaded from the workflow tree's project-row context menu or through:

- `POST /api/workflows/projects/download`

The custom context menu currently exists only on project rows. Folder rows still do not expose download actions.

Download behavior is based on saved server-side state only:

- unsaved editor changes are ignored
- only the `.rivet-project` file is downloaded
- dataset sidecars, settings sidecars, published datasets, and recordings are not included

Current download behavior by status:

- **Unpublished**
  - downloads the saved live project file
  - filename tag: `[unpublished]`
- **Published**
  - one-click `Download` in the dashboard downloads the published version, even if the saved live file currently matches it
  - filename tag: `[published]`
- **Unpublished changes**
  - opens a chooser in the dashboard
  - `Download published` returns the published snapshot
  - `Download unpublished changes` returns the saved live project file with the unpublished edits
  - filename tags: `[published]` and `[unpublished changes]`

The download flow is non-destructive to the current UI state:

- it does not refresh the workflow tree
- it does not change the current selection
- it does not auto-open the downloaded project in the editor
- it does not auto-expand folders

Filename format is:

- `Name [unpublished].rivet-project`
- `Name [published].rivet-project`
- `Name [unpublished changes].rivet-project`

## Endpoint resolution

Two public endpoint families exist:

- **Published** (`${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}/:endpointName`)
  - serves the frozen published snapshot
  - stable across live edits
- **Latest** (`${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}/:endpointName`)
  - serves the live project file for the same published workflow
  - reflects unpublished changes immediately

Both routes:

- are `POST`-only
- look up projects by scanning workflow settings sidecars for a matching published endpoint name
- match endpoint names case-insensitively

Fully unpublished projects are not served by either public route family.

There is also an internal published-only route:

- `POST /internal/workflows/:endpointName`

That route is mounted directly on the API service, is not exposed through nginx, and intentionally skips public bearer auth for trusted intra-stack callers.

## HTTP execution contract

Current request/response behavior for all execution routes:

- the incoming JSON request body becomes the workflow `input`
- an empty body is treated as `{}`
- if the final `output` port is typed as `any`, the response body is that raw output value
- otherwise the response body is the full outputs object
- every response sets `x-duration-ms`
- successful object responses get `durationMs` injected unless already present
- failures return JSON with `error.name`/`error.message` plus `durationMs`

## Workflow execution auth

Public execution auth is separate from the browser UI gate:

- when `RIVET_REQUIRE_WORKFLOW_KEY=true`, both public route families require `Authorization: Bearer <RIVET_KEY>`
- hosts allowlisted in `RIVET_UI_TOKEN_FREE_HOSTS` bypass that public-route auth because nginx forwards a trusted internal-host signal
- if public auth is enabled but `RIVET_KEY` is empty, the public execution routes fail with `500`

See [access-and-routing.md](access-and-routing.md) for the nginx-side details.

## Execution recordings

Every endpoint execution is eligible to persist a recording bundle that the hosted editor can later load and replay:

- published endpoint runs
- latest endpoint runs
- internal published-only runs

Recording capture is intentionally best-effort observability:

- the endpoint response is sent first
- recording persistence is queued in the background after execution finishes
- both successful and failed runs are eligible for recording
- successful runs whose final `output` is `control-flow-excluded` are marked as `suspicious`
- if the queue is full, new recordings are dropped so endpoint execution is not slowed or blocked

Each bundle stores:

```text
.recordings/
  <workflowId>/
    <recordingId>/
      metadata.json
      recording.rivet-recording.gz
      replay.rivet-project.gz
      replay.rivet-data.gz     # only when dataset snapshots are enabled and data was present
```

- `recording.rivet-recording.gz` is the serialized `ExecutionRecorder` output
- `replay.rivet-project.gz` is an immutable replay snapshot of the executed project state
- `replay.rivet-data.gz` is the dataset snapshot, when present
- `metadata.json` stores timestamp, endpoint, run kind, verdict, duration, encoding, and byte counts

Bundles are keyed by the source workflow metadata ID, so recordings stay attached across project renames, moves, and endpoint-name changes. Project deletion removes that recording history as part of workflow cleanup.

Legacy uncompressed bundles are still readable. Startup reconciliation rebuilds the SQLite index from on-disk metadata and normalizes old `version: 1` metadata into the current index shape.

## Recording defaults and retention

Recording behavior is controlled by env vars:

| Variable | Purpose | Default |
|---|---|---|
| `RIVET_RECORDINGS_ENABLED` | Enable workflow recording persistence | `true` |
| `RIVET_RECORDINGS_COMPRESS` | Blob encoding (`gzip` or `identity`) | `gzip` |
| `RIVET_RECORDINGS_GZIP_LEVEL` | Gzip compression level | `4` |
| `RIVET_RECORDINGS_MAX_PENDING_WRITES` | Background queue size before new recordings are dropped | `100` |
| `RIVET_RECORDINGS_INCLUDE_PARTIAL_OUTPUTS` | Include partial outputs in recorder payloads | `false` |
| `RIVET_RECORDINGS_INCLUDE_TRACE` | Include trace data in recorder payloads | `false` |
| `RIVET_RECORDINGS_DATASET_MODE` | Dataset snapshot mode (`none` or `all`) | `none` |
| `RIVET_RECORDINGS_RETENTION_DAYS` | Delete runs older than this many days (`0` disables) | `14` |
| `RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT` | Keep only the newest N runs per endpoint (`0` disables) | `100` |
| `RIVET_RECORDINGS_MAX_TOTAL_BYTES` | Global compressed-byte cap across recordings (`0` disables) | `0` |

Operational defaults are intentionally conservative:

- recordings are enabled and compressed by default
- partial outputs and trace capture are disabled by default
- dataset snapshots are disabled by default
- retention cleanup runs automatically

## Recording index and API shape

The browser does not scan `.recordings/` directly. The API uses `recordings.sqlite` to serve:

- workflow summaries ordered by most recent run
- per-workflow run pagination
- bad-only filtering, where `status=failed` includes both `failed` and `suspicious`
- artifact lookup by `recordingId`
- single-run deletion by `recordingId`

The main recordings routes are:

- `GET /api/workflows/recordings/workflows`
- `GET /api/workflows/recordings/workflows/:workflowId/runs?page=1&pageSize=20&status=all|failed`
- `GET /api/workflows/recordings/:recordingId/recording`
- `GET /api/workflows/recordings/:recordingId/replay-project`
- `GET /api/workflows/recordings/:recordingId/replay-dataset`
- `DELETE /api/workflows/recordings/:recordingId`

`GET /api/workflows/recordings` still exists as a compatibility alias for the workflow-list response, but the dashboard uses `/recordings/workflows`.

## Recording browser

The dashboard exposes a `Run recordings` action next to `Runtime libraries`.

Current browser behavior:

- lists currently published workflows and workflows that still have recording history from earlier publication
- sorts workflows by most recent run
- pages runs from the API instead of materializing the whole history at once
- supports `All` and `Bad only`, where `Bad only` includes both `failed` and `suspicious`
- lets the user delete individual stored runs
- opens a run by `recordingId`, not by raw filesystem path

Deleting a run removes both:

- the bundle under `.recordings/`
- the corresponding SQLite row

If that was the last run for the workflow, the API also removes the workflow-level recordings directory and workflow row from the index.

When a run is opened, the hosted editor:

- fetches the serialized recorder payload
- opens a virtual replay project path such as `recording://<recordingId>/replay.rivet-project`
- loads the replay project and optional dataset through `HostedIOProvider`
- switches playback to browser replay mode
- treats the replay snapshot as read-only

## Project rename, move, and delete behavior

When a project is renamed, moved, duplicated, uploaded, downloaded, or deleted, sidecars and publication artifacts stay consistent:

- **Rename/move**
  - `moveProjectWithSidecars()` renames the project, `.rivet-data`, and `.wrapper-settings.json`
  - folder moves calculate all affected absolute project paths so the dashboard/editor bridge can retarget open tabs
- **Duplicate**
  - creates only a new `.rivet-project` file in the same folder
  - can duplicate either the saved live file or the published snapshot when both exist
  - gives the duplicate a fresh workflow metadata ID and updates its stored title
  - does not copy `.rivet-data`, `.wrapper-settings.json`, `.published/`, or `.recordings/`
- **Upload**
  - creates only a new `.rivet-project` file in the selected folder
  - gives the uploaded project a fresh workflow metadata ID and updates its stored title to the final saved filename base
  - does not create `.rivet-data`, `.wrapper-settings.json`, `.published/`, or `.recordings/`
- **Download**
  - reads either the saved live project file or the published snapshot
  - never downloads unsaved editor state
  - never bundles `.rivet-data`, `.wrapper-settings.json`, `.published/`, or `.recordings/`
- **Delete**
  - deletes the project file and sidecars
  - deletes the published snapshot if one exists
  - deletes recording bundles by workflow ID and by legacy source-path lookup

## Key files

- `wrapper/api/src/routes/workflows/publication.ts` - publication logic, status derivation, endpoint lookup
- `wrapper/api/src/routes/workflows/execution.ts` - public/latest/internal execution handlers
- `wrapper/api/src/routes/workflows/recordings.ts` - recording persistence, listing, migration, and cleanup
- `wrapper/api/src/routes/workflows/recordings-config.ts` - recording env parsing and defaults
- `wrapper/api/src/routes/workflows/recordings-db.ts` - SQLite recording index
- `wrapper/api/src/routes/workflows/workflow-mutations.ts` - duplicate, upload, publish, unpublish, and delete orchestration
- `wrapper/api/src/routes/workflows/workflow-download.ts` - project-download resolution and attachment filename generation
- `wrapper/api/src/routes/workflows/fs-helpers.ts` - sidecar paths, move/delete helpers
- `wrapper/shared/workflow-recording-types.ts` - shared recording types and virtual replay path helpers
