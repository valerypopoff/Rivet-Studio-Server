# Workflow Publication

Workflows can be published as HTTP endpoints. This document explains the internal model.

## Concepts

- **Project file** (`*.rivet-project`): the live, editable workflow file
- **Settings sidecar** (`*.rivet-project.wrapper-settings.json`): stores endpoint name, publication hash, and snapshot ID
- **Published snapshot** (`.published/<id>.rivet-project`): frozen copy of the project at time of publish
- **Dataset sidecar** (`*.rivet-data`): optional data associated with a project, published alongside it

Projects live under the workflow root configured by `RIVET_WORKFLOWS_ROOT` in the API container and backed by `RIVET_WORKFLOWS_HOST_PATH` on the host.

## Status model

Each project has a derived status computed from the settings sidecar:

| Status | Meaning |
|---|---|
| `unpublished` | No endpoint has ever been published |
| `published` | The live file matches the published snapshot (hash match) |
| `unpublished_changes` | An endpoint is published but the live file has diverged from the snapshot |

Status is derived by comparing `publishedStateHash` (stored at publish time) against a fresh hash of the current project file, dataset, and endpoint name. This avoids storing mutable status flags.

In the dashboard UI, status still comes from the server as the source of truth, but saves use a small optimistic update for responsiveness: when a published project is saved, the sidebar can immediately flip it to `unpublished_changes` before the workflow tree refresh completes. That optimistic flip only happens when the editor reports that the save changed persisted `.rivet-project` or `.rivet-data` contents, so a no-op save should stay visually `published`.

## Publish flow

1. User sets an endpoint name and clicks Publish in the settings modal.
2. Server validates the endpoint name is unique (case-insensitive across all projects).
3. Server computes a SHA-256 hash of `endpointName + projectFile + dataset`.
4. Server copies the project file (and dataset if present) into `.published/<snapshotId>.rivet-project`.
5. Server writes the settings sidecar with the endpoint name, snapshot ID, and hash.

## Save flow after publish

1. User saves a published workflow in the editor.
2. The editor compares the to-be-written project and dataset contents with the current on-disk contents.
3. The editor emits `project-saved` with `didChangePersistedState=true` only when the persisted project or dataset bytes actually changed.
4. The dashboard uses that flag to decide whether to optimistically mark the project as `unpublished_changes` before re-fetching the workflow tree.
5. The dashboard then refreshes `/api/workflows/tree` with `cache: 'no-store'` so the server-derived status reconciles quickly.

## Unpublish flow

1. Server deletes the published snapshot and its dataset sidecar.
2. Server clears `publishedEndpointName`, `publishedSnapshotId`, and `publishedStateHash` in the settings sidecar.

## Endpoint resolution

Two endpoint families exist:

- **Published** (`${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}/:endpointName`): serves the frozen snapshot. Stable across edits.
- **Latest** (`${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}/:endpointName`): serves the live project file. Reflects unpublished changes immediately for published projects.

Both look up the project by scanning all settings sidecars for a matching endpoint name (case-insensitive).

Fully unpublished projects are not served by either public route family.

## Auth model

Public execution routes can be protected independently of the browser UI:

- when `RIVET_REQUIRE_WORKFLOW_KEY=true` and `RIVET_KEY` is set, both public route families require `Authorization: Bearer <RIVET_KEY>`
- hosts allowlisted in `RIVET_UI_TOKEN_FREE_HOSTS` can bypass that public-route auth because nginx forwards a trusted internal-host signal to the API

The API also exposes an internal published-only route:

- `/internal/workflows/:endpointName`

That route is mounted directly on the API service, is not exposed through nginx, and intentionally skips bearer auth for trusted intra-stack callers.

## Sidecar lifecycle

When a project is renamed, moved, or deleted, its sidecars travel with it:

- **Rename/move**: `moveProjectWithSidecars()` renames the project, `.rivet-data`, and `.wrapper-settings.json` atomically with rollback on failure.
- **Delete**: `deleteProjectWithSidecars()` removes the project, both sidecars, and any published snapshot.

Published endpoint names preserve the casing the user entered in settings, while endpoint lookup remains case-insensitive.

## Key files

- `wrapper/api/src/routes/workflows/publication.ts` - publication logic, hash computation, endpoint lookup
- `wrapper/api/src/routes/workflows/workflow-mutations.ts` - publish, unpublish, delete orchestration
- `wrapper/api/src/routes/workflows/fs-helpers.ts` - sidecar path helpers, move/delete with sidecars
