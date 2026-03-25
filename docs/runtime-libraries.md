# Runtime Libraries

## Layout

Runtime libraries use a simple on-disk layout:

```text
<root>/
  manifest.json
  current/
    package.json
    node_modules/
  staging/
```

The root path is controlled by `RIVET_RUNTIME_LIBRARIES_ROOT`.

## UI and API

The feature is exposed from the dashboard through the `Runtime libraries` action in the projects pane.

The adjacent `Run recordings` action is separate. It browses stored workflow execution recordings, pages and filters runs through `/api/workflows/recordings/*`, opens replay bundles back into the editor by `recordingId`, and can delete individual stored runs; see [workflow-publication.md](workflow-publication.md) for that flow.

The API surface lives under `/api/runtime-libraries`:

- `GET /` returns current state plus any active job
- `POST /install` starts an install job
- `POST /remove` starts a removal job
- `GET /jobs/:jobId` returns job state
- `GET /jobs/:jobId/stream` streams live logs over SSE

Only one install/remove job runs at a time.

## Activation model

- install/remove jobs build a candidate set in `staging/`
- the candidate is validated before activation
- activation swaps `staging/` into `current/`
- if activation fails, the previous `current/` set is restored

Because both execution paths resolve the active library directory per invocation, newly activated libraries take effect without restarting the API or executor containers.

## Compatibility

Startup still migrates the older `active-release` plus `releases/NNNN/` layout into `current/` if it exists.

## Resolution

- API-side code execution resolves packages from `current/node_modules`
- executor-side code execution resolves packages from the same path via the bundle patch

Workflow replay loading is separate from this system. Replays load frozen project/dataset artifacts from recording storage and do not mutate the active runtime-library set.

## Persistence and fallback

- runtime libraries are persisted outside the container image and survive rebuilds
- API startup reconciles stale or legacy runtime-library state
- when no managed runtime-library set is active, execution falls back to image-baked dependencies
