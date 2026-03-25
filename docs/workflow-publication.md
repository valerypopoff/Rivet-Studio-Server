# Workflow Publication

Workflows can be published as HTTP endpoints. This document explains the internal model.

## Concepts

- **Project file** (`*.rivet-project`): the live, editable workflow file
- **Settings sidecar** (`*.rivet-project.wrapper-settings.json`): stores endpoint name, publication hash, and snapshot ID
- **Published snapshot** (`.published/<id>.rivet-project`): frozen copy of the project at time of publish
- **Dataset sidecar** (`*.rivet-data`): optional data associated with a project, published alongside it
- **Execution recording bundle** (`.recordings/<projectMetadataId>/<recordingId>/`): replayable snapshot of one endpoint execution
- **Recording index** (`<RIVET_APP_DATA_ROOT>/recordings.sqlite`): SQLite metadata index used for listing, pagination, retention, and artifact lookup

Projects live under the workflow root configured by `RIVET_WORKFLOWS_ROOT` in the API container and backed by `RIVET_WORKFLOWS_HOST_PATH` on the host.

Published snapshots and recording blob artifacts both live inside that same workflow tree. There is still no separate recordings host-path setting, so Docker deployments store recording bundles under the host workflow mount selected by `RIVET_WORKFLOWS_HOST_PATH`.

The metadata index is separate: it lives under `RIVET_APP_DATA_ROOT` as `recordings.sqlite`.

## Status model

Each project has a derived status computed from the settings sidecar:

| Status | Meaning |
|---|---|
| `unpublished` | No endpoint has ever been published |
| `published` | The live file matches the published snapshot (hash match) |
| `unpublished_changes` | An endpoint is published but the live file has diverged from the snapshot |

Status is derived by comparing `publishedStateHash` (stored at publish time) against a fresh hash of the current project file, dataset, and endpoint name. This avoids storing mutable status flags.

In the dashboard UI, status still comes from the server as the source of truth, but saves use a small optimistic update for responsiveness: when a published project is saved, the sidebar immediately flips it to `unpublished_changes` for that path and then reconciles against a fresh workflow-tree fetch.

## Publish flow

1. User sets an endpoint name and clicks Publish in the settings modal.
2. Server validates the endpoint name is unique (case-insensitive across all projects).
3. Server computes a SHA-256 hash of `endpointName + projectFile + dataset`.
4. Server copies the project file (and dataset if present) into `.published/<snapshotId>.rivet-project`.
5. Server writes the settings sidecar with the endpoint name, snapshot ID, and hash.

## Save flow after publish

1. User saves a published workflow in the editor.
2. The editor writes the updated project and dataset files.
3. The editor emits `project-saved` after a successful save, and the dashboard immediately marks published workflows as `unpublished_changes` before refreshing the workflow tree from the API.
4. The dashboard refreshes `/api/workflows/tree` and reconciles the optimistic status with the server-derived state.

## Unpublish flow

1. Server deletes the published snapshot and its dataset sidecar.
2. Server clears `publishedEndpointName`, `publishedSnapshotId`, and `publishedStateHash` in the settings sidecar.

## Endpoint resolution

Two endpoint families exist:

- **Published** (`${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}/:endpointName`): serves the frozen snapshot. Stable across edits.
- **Latest** (`${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}/:endpointName`): serves the live project file. Reflects unpublished changes immediately for published projects.

Both look up the project by scanning all settings sidecars for a matching endpoint name (case-insensitive).

Fully unpublished projects are not served by either public route family.

## Execution recordings

Every endpoint execution persists a recording bundle that the hosted editor can later load and replay:

- published endpoint runs (`/workflows/:endpointName`)
- latest endpoint runs (`/workflows-latest/:endpointName`)
- internal published-only runs (`/internal/workflows/:endpointName`)

Recording capture is designed as best-effort observability:

- the endpoint response is sent first
- recording persistence is queued in the background after execution finishes
- both successful and failed runs are eligible for recording
- if the queue is full, new recordings are dropped so endpoint execution is not slowed or blocked

Each bundle stores:

```text
.recordings/
  <sourceProjectMetadataId>/
    <recordingId>/
      metadata.json
      recording.rivet-recording.gz
      replay.rivet-project.gz
      replay.rivet-data.gz     # only when dataset snapshots are enabled and data was present
```

- `recording.rivet-recording.gz` is the serialized `ExecutionRecorder` output
- `replay.rivet-project.gz` is an immutable replay snapshot of the executed project state
- `replay.rivet-data.gz` is the dataset snapshot, when present
- `metadata.json` stores run timestamp, endpoint, run kind (`published` or `latest`), status, duration, bundle encoding, and compressed/uncompressed byte counts

Bundles are keyed by the source project's metadata ID, so recordings stay attached across project renames and moves. Project deletion removes that recording history as part of workflow cleanup.

Legacy uncompressed bundles are still readable. Startup reconciliation rebuilds the SQLite index from bundle metadata on disk and normalizes old `version: 1` recording metadata into the current index shape.

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
| `RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT` | Keep only the newest N runs per endpoint (`0` disables) | `0` |
| `RIVET_RECORDINGS_MAX_TOTAL_BYTES` | Global compressed-byte cap across recordings (`0` disables) | `0` |

Operational defaults are intentionally conservative:

- recordings are compressed by default
- partial outputs and trace capture are disabled by default to control bundle size
- dataset snapshots are disabled by default
- cleanup is automatic and uses both retention and size-based limits

## Recording index and API shape

The browser does not scan the filesystem directly. Instead, the API uses `recordings.sqlite` to serve:

- workflow summaries ordered by most recent run
- per-workflow run pagination
- failed-only filtering
- artifact lookup by `recordingId`

The main recordings routes are:

- `GET /api/workflows/recordings/workflows`
- `GET /api/workflows/recordings/workflows/:workflowId/runs?page=1&pageSize=20&status=all|failed`
- `GET /api/workflows/recordings/:recordingId/recording`
- `GET /api/workflows/recordings/:recordingId/replay-project`
- `GET /api/workflows/recordings/:recordingId/replay-dataset`

## Recording browser

The dashboard exposes a `Run recordings` action next to `Runtime libraries`.

That browser:

- lists currently published workflows and workflows that still have recording history from earlier publication
- sorts workflows by their most recent recorded run
- loads runs page-by-page from the API instead of materializing all runs at once
- supports filtering runs down to failed executions only
- opens a run by `recordingId`, not by raw filesystem path

When a run is opened, the hosted editor:

- fetches the serialized recording and replay artifacts from the API
- opens a virtual replay project path such as `recording://<recordingId>/replay.rivet-project`
- switches playback to browser replay mode
- treats the replay snapshot as read-only; plain save redirects to `Save As`

## Auth model

Public execution routes can be protected independently of the browser UI:

- when `RIVET_REQUIRE_WORKFLOW_KEY=true` and `RIVET_KEY` is set, both public route families require `Authorization: Bearer <RIVET_KEY>`
- hosts allowlisted in `RIVET_UI_TOKEN_FREE_HOSTS` can bypass that public-route auth because nginx forwards a trusted internal-host signal to the API

The API also exposes an internal published-only route:

- `/internal/workflows/:endpointName`

That route is mounted directly on the API service, is not exposed through nginx, and intentionally skips bearer auth for trusted intra-stack callers.

## Sidecar lifecycle

When a project is renamed, moved, or deleted, its sidecars and associated publication artifacts stay consistent:

- **Rename/move**: `moveProjectWithSidecars()` renames the project, `.rivet-data`, and `.wrapper-settings.json` atomically with rollback on failure.
- **Delete**: `deleteProjectWithSidecars()` removes the project and sidecars, while workflow deletion orchestration also removes published snapshots and stored recordings.

Published endpoint names preserve the casing the user entered in settings, while endpoint lookup remains case-insensitive.

## Key files

- `wrapper/api/src/routes/workflows/publication.ts` - publication logic, hash computation, endpoint lookup
- `wrapper/api/src/routes/workflows/recordings.ts` - recording persistence, listing, migration, and cleanup helpers
- `wrapper/api/src/routes/workflows/recordings-config.ts` - recording env parsing and defaults
- `wrapper/api/src/routes/workflows/recordings-db.ts` - SQLite recording index
- `wrapper/api/src/routes/workflows/workflow-mutations.ts` - publish, unpublish, delete orchestration
- `wrapper/api/src/routes/workflows/fs-helpers.ts` - sidecar path helpers, move/delete with sidecars
- `wrapper/shared/workflow-recording-types.ts` - shared recording types and virtual replay path helpers
