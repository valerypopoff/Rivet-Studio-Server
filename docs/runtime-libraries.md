# Runtime Libraries

Managed runtime libraries let hosted Rivet `Code` nodes `require()` packages that are not baked into the base images.

The dashboard exposes this through the `Runtime libraries` button in the left panel.

## Backend modes

Runtime libraries now follow `RIVET_STORAGE_MODE`:

- `filesystem`
- `managed`

`filesystem` preserves the original single-host layout and is only valid when the
backend is not scaled beyond one replica.

`managed` stores:

- release metadata, activation state, and job state in Postgres
- immutable release artifacts in object storage
- `current/` under `RIVET_RUNTIME_LIBRARIES_ROOT` as a local extracted cache

Managed mode reuses the same database and object-storage connection settings as
managed workflow storage and uses the fixed object key prefix `runtime-libraries/`.
That means `RIVET_STORAGE_MODE=managed` switches both workflows and runtime libraries
to the managed backend together.

Canonical managed config:

- `RIVET_STORAGE_MODE=managed`
- `RIVET_DATABASE_MODE=local-docker|managed`
- `RIVET_DATABASE_CONNECTION_STRING`
- `RIVET_DATABASE_SSL_MODE=disable|require|verify-full`
- recommended object-storage URL form:
  - `RIVET_STORAGE_URL`
  - `RIVET_STORAGE_ACCESS_KEY_ID`
  - `RIVET_STORAGE_ACCESS_KEY`
- optional explicit S3 tuple form:
  - `RIVET_STORAGE_BUCKET`
  - `RIVET_STORAGE_REGION`
  - `RIVET_STORAGE_ENDPOINT`
  - `RIVET_STORAGE_ACCESS_KEY_ID`
  - `RIVET_STORAGE_ACCESS_KEY`
  - `RIVET_STORAGE_PREFIX`
  - `RIVET_STORAGE_FORCE_PATH_STYLE`
- optional runtime-library sync tuning:
  - `RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS`

Retired aliases such as `RIVET_WORKFLOWS_STORAGE_*`, `RIVET_OBJECT_STORAGE_*`,
`RIVET_STORAGE_BACKEND`, and `RIVET_RUNTIME_LIBS_SYNC_POLL_INTERVAL_MS` now fail fast.

## On-disk layout

Runtime libraries use a simple persistent layout rooted at `RIVET_RUNTIME_LIBRARIES_ROOT`:

```text
<root>/
  manifest.json
  current/
    package.json
    node_modules/
  jobs/
```

During activation, the runtime-library backend may also create a transient `current.previous`
backup while swapping the extracted release into place.

In `managed` mode, this root is a local cache/workspace only. The authoritative source
of truth is:

- Postgres for release metadata, activation state, and job state
- object storage for immutable `runtime-libraries/releases/<releaseId>/release.tar` artifacts

## API surface

The runtime-library API lives under `/api/runtime-libraries`:

- `GET /` returns the current manifest, `hasActiveLibraries`, `updatedAt`, and any active job
- `POST /install` starts an install job
- `POST /remove` starts a removal job
- `GET /jobs/:jobId` returns the current/most-recent job state
- `POST /jobs/:jobId/cancel` requests cancellation of a queued or running job
- `GET /jobs/:jobId/stream` streams job logs and status changes over SSE

Only one install/remove job can run at a time.

In `managed` mode that exclusivity is enforced in Postgres, not only in process memory.

## Job lifecycle

Current job statuses are:

- `queued`
- `running`
- `validating`
- `activating`
- `succeeded`
- `failed`

The dashboard opens an `EventSource` to `/jobs/:jobId/stream` and appends log lines live while the job runs.

Cancellation behavior:

- the UI or API can request cancellation while a job is queued or running
- the backend records `cancelRequestedAt` and stops the install/remove flow as soon as it can do so safely
- cancellation does not create a partial successful release; the previously active release remains active
- the current terminal state remains `failed`, with the cancellation time preserved in the job payload

## Install/remove model

Install and remove both rebuild a complete candidate release:

1. Read the active package set from the selected backend.
2. Add or remove the requested package entries from the candidate set.
3. Recreate a temporary candidate directory.
4. Generate a synthetic `package.json` with the candidate dependencies.
5. Run `npm install --omit=dev --no-audit --no-fund` when dependencies are present.
6. Validate every requested package by resolving it from the candidate `node_modules`.
7. In `managed` mode, archive the full release and upload it to object storage.
8. Activate the new release.
9. Update the local `current/` cache and `manifest.json`.

If activation fails after moving the previous `current/` aside, the runtime-library backend restores the backup release.

## Resolution behavior

Both execution paths resolve managed libraries from `current/node_modules`:

- the API uses `ManagedCodeRunner`
- the executor bundle is patched to resolve from the same runtime-library root

That means newly activated libraries take effect on the next workflow execution without restarting the API container.
In `managed` mode the executor bootstrap now reconciles the same active release into its own local `current/` cache before code-node `require()` resolution, so it no longer depends on a shared authoritative runtime-library mount.
API processes do the same before endpoint-side execution, so both endpoint execution and editor execution converge to the same active managed release.

If no managed runtime-library set is active, code execution falls back to the dependencies baked into the running image / normal Node resolution.

## Persistence and reconciliation

Current persistence rules:

- runtime libraries live outside the container image and survive rebuilds/restarts
- startup creates missing directories
- startup migrates the older `active-release` plus `releases/<id>/` layout into the current `current/` layout if needed
- if `manifest.json` says packages are installed but `current/node_modules` is missing, startup clears the stale manifest state and starts clean
- in `managed` mode, startup reconciles the local `current/` cache from the active managed release before execution uses it
- in `managed` mode, job logs and status survive refreshes and API restarts because they are stored in Postgres
- in `managed` mode, executor processes run the same reconciliation logic through the bootstrap layer before code execution

## Managed cleanup tooling

Managed runtime-library state accumulates historical release rows, job rows, and
release artifacts. The repo now includes safe cleanup commands:

- `npm run runtime-libraries:managed:audit`
- `npm run runtime-libraries:managed:prune`
- `npm run runtime-libraries:managed:prune -- --apply`

`audit` is read-only and writes a JSON snapshot under:

- `artifacts/runtime-library-cleanup/<timestamp>/audit.json`

Those generated snapshots are operational artifacts, not source files, and are ignored by Git.

`prune` is dry-run by default. It writes a pre-prune snapshot and prints the exact
release rows, job rows, and orphaned object-storage keys that would be deleted.

Retention policy:

- never delete the active release
- never delete releases referenced by queued/running/validating/activating jobs
- never delete releases newer than 7 days
- always retain the 5 newest inactive releases
- keep successful job rows for 30 days
- keep failed/cancelled job rows for 14 days
- delete orphaned runtime-library artifacts only if they are older than 24 hours

Integrity rule:

- release rows whose artifact is already missing are reported as integrity errors
- prune does not auto-delete those release rows
- post-prune verification fails if any retained release still points to a missing artifact

## UI behavior

The current wrapper UI exposes a simple single-package workflow:

- install one package name/version at a time
- remove installed packages one at a time
- cancel a queued or running job from the modal
- show the live job log inline in the modal

The underlying API accepts arrays for install/remove requests, so bulk operations are possible programmatically even though the dashboard currently uses one-at-a-time actions.

## Related feature

The adjacent `Run recordings` action is separate. It browses stored workflow execution recordings, opens replay bundles back into the editor by `recordingId`, and can delete individual runs; see [workflow-publication.md](workflow-publication.md).
