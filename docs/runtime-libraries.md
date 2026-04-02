# Runtime Libraries

Managed runtime libraries let hosted Rivet `Code` nodes `require()` packages that are not baked into the base images.

The dashboard exposes this through the `Runtime libraries` button in the left panel.

## On-disk layout

Runtime libraries use a simple persistent layout rooted at `RIVET_RUNTIME_LIBRARIES_ROOT`:

```text
<root>/
  manifest.json
  current/
    package.json
    node_modules/
  staging/
```

During activation, the job runner may also create a transient `current.previous` backup while swapping the staged release into place.

## API surface

The runtime-library API lives under `/api/runtime-libraries`:

- `GET /` returns the current manifest, `hasActiveLibraries`, `updatedAt`, and any active job
- `POST /install` starts an install job
- `POST /remove` starts a removal job
- `GET /jobs/:jobId` returns the current/most-recent job state
- `GET /jobs/:jobId/stream` streams job logs and status changes over SSE

Only one install/remove job can run at a time.

## Job lifecycle

Current job statuses are:

- `queued`
- `running`
- `validating`
- `activating`
- `succeeded`
- `failed`

The dashboard opens an `EventSource` to `/jobs/:jobId/stream` and appends log lines live while the job runs.

## Install/remove model

Install and remove both rebuild a complete candidate release:

1. Read `manifest.json`.
2. Add or remove the requested package entries from the candidate set.
3. Recreate `staging/`.
4. Generate a synthetic `package.json` with the candidate dependencies.
5. Run `npm install --production --no-audit --no-fund` in `staging/` when dependencies are present.
6. Validate every requested package by resolving it from `staging/node_modules`.
7. Atomically promote `staging/` to `current/`.
8. Update `manifest.json`.

If activation fails after moving the previous `current/` aside, the runner restores the backup release.

## Resolution behavior

Both execution paths resolve managed libraries from `current/node_modules`:

- the API uses `ManagedCodeRunner`
- the executor bundle is patched to resolve from the same runtime-library root

That means newly activated libraries take effect on the next workflow execution without restarting the API or executor containers.

If no managed runtime-library set is active, code execution falls back to the dependencies baked into the running image / normal Node resolution.

## Persistence and reconciliation

Current persistence rules:

- runtime libraries live outside the container image and survive rebuilds/restarts
- startup creates missing directories
- startup migrates the older `active-release` plus `releases/<id>/` layout into the current `current/` layout if needed
- if `manifest.json` says packages are installed but `current/node_modules` is missing, startup clears the stale manifest state and starts clean

## UI behavior

The current wrapper UI exposes a simple single-package workflow:

- install one package name/version at a time
- remove installed packages one at a time
- show the live job log inline in the modal

The underlying API accepts arrays for install/remove requests, so bulk operations are possible programmatically even though the dashboard currently uses one-at-a-time actions.

## Related feature

The adjacent `Run recordings` action is separate. It browses stored workflow execution recordings, opens replay bundles back into the editor by `recordingId`, and can delete individual runs; see [workflow-publication.md](workflow-publication.md).
