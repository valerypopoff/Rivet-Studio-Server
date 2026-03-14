# Workflow Publication

Workflows can be published as HTTP endpoints. This document explains the internal model.

## Concepts

- **Project file** (`*.rivet-project`): the live, editable workflow file
- **Settings sidecar** (`*.rivet-project.wrapper-settings.json`): stores endpoint name, publication hash, and snapshot ID
- **Published snapshot** (`.published/<id>.rivet-project`): frozen copy of the project at time of publish
- **Dataset sidecar** (`*.rivet-data`): optional data associated with a project, published alongside it

## Status model

Each project has a derived status computed from the settings sidecar:

| Status | Meaning |
|---|---|
| `unpublished` | No endpoint has ever been published |
| `published` | The live file matches the published snapshot (hash match) |
| `unpublished_changes` | An endpoint is published but the live file has diverged from the snapshot |

Status is derived by comparing `publishedStateHash` (stored at publish time) against a fresh hash of the current project file, dataset, and endpoint name. This avoids storing mutable status flags.

## Publish flow

1. User sets an endpoint name and clicks Publish in the settings modal.
2. Server validates the endpoint name is unique (case-insensitive across all projects).
3. Server computes a SHA-256 hash of `endpointName + projectFile + dataset`.
4. Server copies the project file (and dataset if present) into `.published/<snapshotId>.rivet-project`.
5. Server writes the settings sidecar with the endpoint name, snapshot ID, and hash.

## Unpublish flow

1. Server deletes the published snapshot and its dataset sidecar.
2. Server clears `publishedEndpointName`, `publishedSnapshotId`, and `publishedStateHash` in the settings sidecar.

## Endpoint resolution

Two endpoint families exist:

- **Published** (`/workflows/published/:endpointName`): serves the frozen snapshot. Stable across edits.
- **Latest** (`/workflows/latest/:endpointName`): serves the live project file. Reflects unsaved changes immediately.

Both look up the project by scanning all settings sidecars for a matching endpoint name (case-insensitive).

## Sidecar lifecycle

When a project is renamed, moved, or deleted, its sidecars travel with it:

- **Rename/move**: `moveProjectWithSidecars()` renames the project, `.rivet-data`, and `.wrapper-settings.json` atomically with rollback on failure.
- **Delete**: `deleteProjectWithSidecars()` removes the project, both sidecars, and any published snapshot.

## Key files

- `wrapper/api/src/routes/workflows/publication.ts` - publication logic, hash computation, endpoint lookup
- `wrapper/api/src/routes/workflows/workflow-mutations.ts` - publish, unpublish, delete orchestration
- `wrapper/api/src/routes/workflows/fs-helpers.ts` - sidecar path helpers, move/delete with sidecars
