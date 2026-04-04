# State Externalization, Kubernetes Adoption, and Scale-Out Plan

## Summary

The roadmap should start with state externalization, not Kubernetes.

Prepare the app in four deliberate phases:

1. `Phase 1`: introduce a storage abstraction with two backends, keep filesystem backward compatibility, and implement the managed workflow/recording backend
2. `Phase 2`: externalize runtime-library distribution and the remaining execution-critical local state needed for multi-replica workflow execution
3. `Phase 3`: adopt Kubernetes on top of the managed-state architecture
4. `Phase 4`: scale the execution path for high-volume traffic

Inside `Phase 1`, add a required `Phase 1.1` hardening pass:

- make managed mode fast enough for normal editor use before moving on to runtime-library externalization or Kubernetes
- treat managed-mode latency as part of state externalization quality, not as optional polish

The reason for this order is simple:

- the current `workflows/` folder model is the biggest obstacle to shared truth across replicas
- the current runtime-library folder model is another source of host-local truth for code execution
- Kubernetes does not solve shared state by itself
- once workflow, recording, and runtime-library state live in shared infrastructure, Kubernetes becomes much safer and much more useful

The long-term goal remains the same: the app must eventually survive huge demand without relying on a single host machine or a single local folder tree.

Compatibility rule:

- the app should support both `filesystem` and `managed` workflow-and-recording storage backends during the transition
- the app should support both `filesystem` and `managed` runtime-library backends during the transition
- `filesystem` exists for backward compatibility, local development, migration, and rollback
- `filesystem` is allowed only when backend runs as a single replica with no backend autoscaling
- `managed` is the required backend for Kubernetes-first shared truth and future scale

Chosen target architecture:

- managed `Postgres` outside Kubernetes
- managed `S3-compatible object storage` outside Kubernetes
- Kubernetes runs only the app workloads
- autoscaling applies to stateless app tiers, not to the database

Supported development topology:

- `filesystem` backend for local development and backward-compatible operation
- `managed` backend when shared services are available

## End-State Mental Model

The future scaled system should not try to keep many pod-local `workflows` folders in sync.

That is the wrong model.

The correct model is:

- database is the source of truth for workflow metadata, folder tree, draft/published pointers, endpoint ownership, recordings index, runtime-library releases, and runtime-library activation state
- object storage is the source of truth for large immutable artifacts such as project revisions, datasets, published snapshots, recording bundles, and runtime-library release artifacts
- pods are stateless workers that read and write through those shared systems

After phase 1, the app can run in one of two modes:

- `filesystem` mode: the current host `workflows/` directory remains the source of truth
- `managed` mode: Postgres plus object storage become the source of truth, and the old host folder becomes migration input and backup material only

## Current State: What Is Already Good To Go

These parts already map well to the future plan:

- the runtime is already split into distinct services:
  - `proxy`
  - `web`
  - `api`
  - `executor`
- the trusted-proxy boundary is already explicit
- websocket paths are already explicit
- the UI gate model is already proxy-based
- Docker images already exist conceptually for each service
- backend config is already env-driven

These parts are not ready for multi-replica scale:

- workflow tree, project files, publication snapshots, and recordings are filesystem-backed
- publication lookup currently scans project files
- recordings index currently uses local `recordings.sqlite`
- runtime-library releases currently live under `RIVET_RUNTIME_LIBRARIES_ROOT` as host-local files
- latest debugger state is process-local
- runtime-library job runner and SSE stream are process-local
- public workflow execution currently happens inside the API process

## Phase 1: Storage Abstraction And State Externalization - DONE

Phase 1 introduces a storage abstraction with two implementations:

- `filesystem`
- `managed`

The `filesystem` backend preserves current behavior for backward compatibility.
The `managed` backend is the new architecture for shared truth.

### Phase 1 goals

- keep backward compatibility with the current local `workflows/` folder model
- stop hard-wiring workflow routes to local filesystem semantics
- stop hard-wiring hosted editor project IO and dataset IO to raw host paths in `managed` mode
- move workflow metadata and recording metadata into a shared database
- move project revisions, published snapshots, datasets, and recording artifacts into object storage
- make every pod able to observe the same workflow state without shared local folders
- preserve the current product semantics for rename, move, duplicate, upload, publish, replay, and workflow status
- add conflict-safe shared-state behavior for concurrent save and publish operations
- keep the user-visible product behavior the same
- make managed-mode rename and open performance acceptable over real remote Postgres plus object storage

Current implementation status:

- `DONE`: backward-compatible `filesystem` mode remains the default path
- `DONE`: a selectable `managed` workflow backend now exists in code and is wired behind env-based backend selection
- `DONE`: real migration and verification tooling exists and has already imported live filesystem workflows plus recordings into the managed backend during rehearsal
- `DONE`: local Docker rehearsal for the managed backend now exists with Postgres plus MinIO-backed object storage
- `DONE`: hosted-editor managed-mode parity has now been exercised successfully against the managed prod-style stack, including the workflow tree, editor open, save path selection, and clipboard/focus behavior
- `DONE`: conflict handling and end-to-end managed-mode parity have now been validated with stale-save conflict checks, endpoint-name conflict checks, dataset round-tripping, publish/unpublish, published execution, and recordings persistence
- `OPEN`: managed-mode latency is still too high for folder rename and project open when the backend talks to real remote Postgres plus object storage, so a dedicated optimization pass is required before Phase 2

### Storage backend abstraction

The app should expose one internal workflow-storage interface and implement two backends behind it:

1. `filesystem`
2. `managed`

#### `filesystem` backend

Purpose:

- preserve current behavior
- keep existing deployments working
- support local development
- support migration verification and rollback

Behavior:

- source of truth remains the local workflow tree
- existing sidecar files remain authoritative
- existing `RIVET_WORKFLOWS_ROOT` and `RIVET_WORKFLOWS_HOST_PATH` behavior remains valid

Constraint:

- this backend is not valid for multi-replica scale
- this backend requires backend replica count `1`
- this backend requires backend HPA to remain disabled

#### `managed` backend

Purpose:

- shared truth across replicas
- future Kubernetes deployment
- future execution scale-out

Behavior:

- source of truth is Postgres plus S3-compatible object storage
- pods do not depend on local workflow folders
- the production target for this backend is managed Postgres plus managed S3-compatible object storage
- development and migration rehearsal may emulate those dependencies with local Docker services

Rule:

- one deployment chooses exactly one backend
- do not run mixed live writes across `filesystem` and `managed` backends in the same environment
- migration between backends happens by controlled import/cutover, not by long-lived dual truth
- if the selected backend is `filesystem`, backend scaling above `1` replica is unsupported

Status now:

- `DONE`: `wrapper/api/src/routes/workflows/storage-backend.ts` now routes workflow behavior through backend selection instead of assuming one hard-wired filesystem implementation
- `DONE`: `wrapper/api/src/routes/workflows/managed/backend.ts` now implements the managed backend with Postgres state, object-storage blobs, managed virtual paths, and recording import/read flows
- `DONE`: `wrapper/api/src/routes/workflows/managed/blob-store.ts` now initializes the target S3-compatible bucket automatically during local rehearsal

### Required internal seams in phase 1

Phase 1 should not stop at a single vague "storage abstraction". It needs distinct internal seams so the current filesystem assumptions do not leak back in.

Recommended internal interfaces:

- `WorkflowCatalogStore`
  - owns folders, workflows, logical paths, endpoint ownership, draft/published pointers, and status metadata
- `WorkflowBlobStore`
  - owns revision blobs, dataset blobs, published snapshot blobs, and recording artifacts
- `WorkflowRecordingStore`
  - owns recording metadata queries, retention decisions, and replay artifact lookup
- `HostedProjectIO`
  - owns hosted editor list/open/save/save-as behavior without exposing raw host filesystem writes in `managed` mode

Implementation rule:

- `filesystem` mode can continue mapping these seams to real files and sidecars
- `managed` mode must implement them with Postgres, object storage, and virtual workflow references rather than absolute host paths

### Configuration surface

Add an env that selects the workflow-and-recording storage backend:

- `RIVET_STORAGE_MODE=filesystem|managed`

Recommended default during the transition:

- `filesystem`

Operational rule:

- when `RIVET_STORAGE_MODE=filesystem`, backend replica count must stay `1`
- when `RIVET_STORAGE_MODE=filesystem`, backend HPA must stay disabled

#### Filesystem backend envs

Keep the current envs for backward compatibility:

- `RIVET_ARTIFACTS_HOST_PATH`
- `RIVET_WORKFLOWS_ROOT`
- `RIVET_WORKFLOWS_HOST_PATH`

Convenience rule:

- `RIVET_ARTIFACTS_HOST_PATH` may act as a shared filesystem root for local Docker artifacts
- when it is set, launcher tooling may derive:
  - `RIVET_WORKFLOWS_HOST_PATH=<artifactsRoot>/workflows`
  - `RIVET_RUNTIME_LIBS_HOST_PATH=<artifactsRoot>/runtime-libraries`
- explicit per-path envs still override the derived paths

#### Managed backend envs

The managed backend requires both database and object-storage configuration.

Use app-specific env names:

- `RIVET_DATABASE_MODE=local-docker|managed`
- `RIVET_DATABASE_URL`
- `RIVET_DATABASE_SSL_MODE=disable|require|verify-full`
- `RIVET_OBJECT_STORAGE_BUCKET`
- `RIVET_OBJECT_STORAGE_REGION`
- `RIVET_OBJECT_STORAGE_ENDPOINT`
- `RIVET_OBJECT_STORAGE_ACCESS_KEY_ID`
- `RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY`
- `RIVET_OBJECT_STORAGE_PREFIX`
- `RIVET_OBJECT_STORAGE_FORCE_PATH_STYLE`

Guidance:

- `RIVET_DATABASE_MODE=local-docker` is allowed for development, migration rehearsal, and non-production validation
- `RIVET_DATABASE_MODE=managed` is the target mode for Kubernetes production deployments
- `RIVET_DATABASE_URL` is the runtime connection contract to the managed Postgres service
- `RIVET_DATABASE_SSL_MODE=disable` is the normal default for local Docker Postgres
- `RIVET_DATABASE_SSL_MODE=require` or stronger is the expected target for managed Postgres such as AWS RDS
- `RIVET_OBJECT_STORAGE_ENDPOINT` is optional for AWS S3 and required for many S3-compatible vendors such as MinIO
- `RIVET_OBJECT_STORAGE_FORCE_PATH_STYLE=true` is often needed for MinIO and some S3-compatible systems
- the official app contract should stay `RIVET_`-prefixed even if the implementation internally uses an AWS-compatible SDK

Example local `.env` for filesystem mode:

```dotenv
RIVET_ARTIFACTS_HOST_PATH=../
RIVET_STORAGE_MODE=filesystem
```

Example local `.env` for managed mode:

```dotenv
RIVET_STORAGE_MODE=managed
RIVET_DATABASE_MODE=local-docker
RIVET_DATABASE_URL=postgres://user:password@localhost:5432/rivet
RIVET_DATABASE_SSL_MODE=disable
RIVET_OBJECT_STORAGE_BUCKET=rivet-workflows
RIVET_OBJECT_STORAGE_REGION=eu-central-1
RIVET_OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:9000
RIVET_OBJECT_STORAGE_ACCESS_KEY_ID=minioadmin
RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY=minioadmin
RIVET_OBJECT_STORAGE_PREFIX=workflows/
RIVET_OBJECT_STORAGE_FORCE_PATH_STYLE=true
```

Example production-style `.env` or secret wiring for managed mode:

```dotenv
RIVET_STORAGE_MODE=managed
RIVET_DATABASE_MODE=managed
RIVET_DATABASE_URL=postgres://user:password@my-rds-host:5432/rivet
RIVET_DATABASE_SSL_MODE=require
RIVET_OBJECT_STORAGE_BUCKET=rivet-workflows
RIVET_OBJECT_STORAGE_REGION=eu-central-1
# Endpoint can be omitted for AWS S3
RIVET_OBJECT_STORAGE_ACCESS_KEY_ID=...
RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY=...
RIVET_OBJECT_STORAGE_PREFIX=workflows/
RIVET_OBJECT_STORAGE_FORCE_PATH_STYLE=false
```

Status now:

- `DONE`: `.env.example` now documents the Phase 1 env surface for backend selection, database mode, and object-storage settings
- `DONE`: `ops/docker-compose.yml` and `ops/docker-compose.dev.yml` now pass the managed-backend envs into the `api` container
- `DONE`: `scripts/dev-docker.mjs` and `scripts/prod-docker.mjs` now auto-enable the `workflow-managed` compose profile when `RIVET_STORAGE_MODE=managed` and `RIVET_DATABASE_MODE=local-docker`
- `DONE`: local managed rehearsal services now exist in compose as `workflow-postgres`, `workflow-minio`, and `workflow-minio-init`

### Shared state model

Use two shared persistence systems:

1. `Postgres`
2. `S3-compatible object storage`

Preferred deployment model for those systems:

- managed `Postgres` service outside Kubernetes
- managed `S3-compatible object storage` service outside Kubernetes

Supported local emulation model:

- local Docker `Postgres`
- local Docker S3-compatible storage such as `MinIO`

Do not design phase 1 around running Postgres inside the app cluster.
Do not treat HPA as a database-scaling strategy.

#### Postgres owns

- folders tree
- workflow identities
- workflow display names and logical paths
- draft revision pointers
- published revision pointers
- endpoint ownership and uniqueness
- workflow status metadata
- publication timestamps
- recordings index and metadata
- future coordination rows for background jobs if needed

#### Object storage owns

- draft project revision blobs
- dataset blobs
- published snapshot blobs
- replay project blobs
- recording payload blobs
- replay dataset blobs

Rule:

- database stores metadata and pointers
- object storage stores immutable content blobs
- Kubernetes should consume these as external dependencies, not host them as app-level stateless workloads

Status now:

- `DONE`: the managed backend schema and blob-store path are implemented against Postgres plus S3-compatible storage
- `DONE`: the local rehearsal path uses Docker Postgres plus MinIO so the managed architecture can be exercised without cloud dependencies
- `DONE`: managed-backend initialization now retries cleanly after failed startup instead of caching a rejected initialization forever

### Workflow data model

Implement a revision-based model.

Recommended logical tables:

- `workflow_folders`
- `workflows`
- `workflow_revisions`
- `workflow_publications`
- `workflow_endpoints`
- `workflow_recordings`

Recommended behavior:

- each save creates a new immutable draft revision blob in object storage
- the database updates the workflow's current draft revision pointer
- each publish creates or points to an immutable published revision
- the database atomically updates the published revision pointer and endpoint mapping
- folder moves and renames update logical path metadata without changing workflow identity

Do not model published state as "copying files into another folder" anymore.

### Transaction, identity, and conflict rules

Phase 1 needs explicit consistency rules so the managed backend is safe under concurrent edits.

Required rules:

- `workflow.metadata.id` remains the stable workflow identity across save, rename, move, publish, migration, and replay lookup
- logical folder path is mutable metadata, not the durable identity of a workflow
- recordings, publications, and future audit data link to workflow id and revision id, not to mutable path strings
- each draft save in `managed` mode writes a full immutable revision snapshot, not an in-place mutable blob edit
- each publish in `managed` mode updates published revision pointer plus endpoint mapping in one database transaction
- endpoint uniqueness must be enforced by a database constraint on normalized endpoint name, not by filesystem scanning
- save and publish operations must use optimistic concurrency or revision-version checks so stale clients fail with a conflict instead of silently overwriting newer state
- if object upload succeeds but the database transaction fails, the blob remains unreachable and is cleaned up later by garbage collection
- delete and unpublish operations must clear authoritative database pointers first and clean up unreferenced blobs afterward

Behavioral rule:

- no replica should ever observe a half-published state where endpoint mapping points to a revision that is not yet authoritative in the database

Status now:

- `DONE`: the managed save/import path was fixed so new workflows create the `workflows` row before inserting dependent revision rows, removing the earlier foreign-key failure during migration
- `DONE`: optimistic concurrency and stale-writer conflict behavior have now been exercised against the managed stack; stale saves return `409 Conflict` instead of silently overwriting newer revisions

### Recording data model

Replace the current local `recordings.sqlite` plus local bundle folders with:

- recording metadata rows in Postgres
- recording artifact blobs in object storage

Recording rows should contain:

- recording id
- workflow id
- workflow revision id or published revision id
- created-at timestamp
- run status
- duration
- endpoint name at execution
- object keys for artifacts
- compressed and uncompressed size metadata
- replay dataset presence flag

### What happens to the current `workflows` folder

The answer depends on the selected backend.

#### In `filesystem` mode

- the current host `workflows/` directory remains the runtime source of truth
- this preserves current behavior
- this is the backward-compatible mode
- this mode is only supported when backend runs with exactly one replica

#### In `managed` mode

- the current host `workflows/` directory becomes migration input, not runtime state

Its contents must be imported into the new shared systems:

- `.rivet-project` files
- `.rivet-data` sidecars
- `.wrapper-settings.json` sidecars
- `.published/`
- `.recordings/`

After successful import:

- the database and object storage become authoritative
- the old host `workflows/` directory is retained only for backup and rollback
- the runtime should no longer depend on mounting that directory

### Save, edit, and publish semantics after phase 1

The public product behavior should stay the same across both backends.

When a user edits or creates a workflow in `managed` mode:

1. the request reaches any control-plane replica
2. that replica writes the new revision blob to object storage
3. that replica updates the database row for the workflow inside a transaction
4. every other replica sees the same workflow state by reading from the database

When a user publishes in `managed` mode:

1. the publish operation creates or references an immutable published revision blob
2. the database updates the workflow's published pointer inside a transaction
3. endpoint-to-published-revision mapping becomes visible to every replica immediately through the shared database

Do not rely on per-pod filesystem refresh for propagation.

In `filesystem` mode, current behavior remains:

- saves, edits, and publish operations still update the local workflow tree and sidecars
- this is compatible behavior, not the scalable target behavior

### Hosted editor IO contract in phase 1

This is a required part of phase 1, not a follow-up detail.

Today the hosted editor still relies on path-based server IO:

- [HostedIOProvider.ts](/d:/Programming/Self-hosted-rivet/wrapper/web/io/HostedIOProvider.ts)
- [datasets.ts](/d:/Programming/Self-hosted-rivet/wrapper/web/overrides/io/datasets.ts)
- [native.ts](/d:/Programming/Self-hosted-rivet/wrapper/api/src/routes/native.ts)
- [projects.ts](/d:/Programming/Self-hosted-rivet/wrapper/api/src/routes/projects.ts)

That contract is filesystem-oriented and is not valid for the `managed` backend.

Required rule:

- `/api/native/*` and `/api/projects/list` remain compatibility paths for `filesystem` mode only
- `managed` mode must give the hosted editor a workflow-aware IO contract that does not require prompting for writable host file paths

Recommended managed-mode behavior:

- project list returns logical workflows and folders, not absolute host paths
- open loads the current draft revision by workflow id or logical project reference
- save updates the current draft revision for an existing workflow id
- save-as creates a new workflow in a logical folder and returns a new workflow reference
- dataset load/save follows the same workflow-aware contract and stops assuming `.rivet-data` sits next to a writable `.rivet-project` file on disk
- import/export of standalone files can still use compatibility or explicit import/export APIs, but live managed projects should not depend on raw native file writes
- workflow tree payloads must stop treating host `absolutePath` values as meaningful runtime identifiers in `managed` mode

Representation rule:

- if the editor still needs a "path-like" value for compatibility, it must be a virtual project reference owned by the app, not a host filesystem path

Status now:

- `DONE`: managed virtual workflow paths now exist in `wrapper/shared/workflow-types.ts` and `wrapper/api/src/routes/workflows/virtual-paths.ts`
- `DONE`: `wrapper/web/io/HostedIOProvider.ts` now detects `RIVET_STORAGE_MODE=managed` and uses a managed virtual save target for newly saved hosted projects instead of defaulting back to `/workflows/...`
- `DONE`: managed-mode hosted-editor open/list/save parity has now been verified through the managed prod-style stack with the headless Playwright browser run
- `DONE`: dataset IO parity in managed mode has now been verified by saving a managed project with dataset contents, reloading it through `/api/projects/load`, and confirming the dataset payload round-trips intact

### Endpoint resolution after phase 1

Endpoint lookup should become backend-specific behind the storage abstraction.

In `managed` mode, replace recursive project-file search with a direct indexed database lookup:

- endpoint name -> published workflow revision
- endpoint name -> latest draft workflow revision, if latest execution remains supported

In `filesystem` mode, current lookup behavior may remain temporarily for compatibility, but it should be isolated behind the storage adapter rather than leaking into route code.

### Code areas that must be refactored in phase 1

The following filesystem-centric areas need storage-adapter redesign:

- [workflow-mutations.ts](/d:/Programming/Self-hosted-rivet/wrapper/api/src/routes/workflows/workflow-mutations.ts)
- [workflow-query.ts](/d:/Programming/Self-hosted-rivet/wrapper/api/src/routes/workflows/workflow-query.ts)
- [publication.ts](/d:/Programming/Self-hosted-rivet/wrapper/api/src/routes/workflows/publication.ts)
- [recordings.ts](/d:/Programming/Self-hosted-rivet/wrapper/api/src/routes/workflows/recordings.ts)
- [recordings-db.ts](/d:/Programming/Self-hosted-rivet/wrapper/api/src/routes/workflows/recordings-db.ts)
- [fs-helpers.ts](/d:/Programming/Self-hosted-rivet/wrapper/api/src/routes/workflows/fs-helpers.ts)

Introduce a storage abstraction so workflow routes stop depending directly on local filesystem semantics.

The hosted editor seams also need redesign:

- [HostedIOProvider.ts](/d:/Programming/Self-hosted-rivet/wrapper/web/io/HostedIOProvider.ts)
- [datasets.ts](/d:/Programming/Self-hosted-rivet/wrapper/web/overrides/io/datasets.ts)
- [native.ts](/d:/Programming/Self-hosted-rivet/wrapper/api/src/routes/native.ts)
- [projects.ts](/d:/Programming/Self-hosted-rivet/wrapper/api/src/routes/projects.ts)

Phase 1 is incomplete if workflow routes use shared state but the editor still saves through raw path-based native IO.

Status now:

- `DONE`: new shared routing and backend-selection logic now exists in `wrapper/api/src/routes/workflows/storage-backend.ts`
- `DONE`: managed virtual-path support now exists as a first-class compatibility layer instead of relying on raw host paths
- `DONE`: `native` and `projects` route wiring has already been touched as part of the managed-backend work
- `DONE`: route-level backend selection and hosted-editor UI behavior have now been exercised together successfully on the managed stack

### Migration tooling required in phase 1

Implement dedicated migration tooling:

- importer from current `workflows/` directory into Postgres and object storage
- verifier that compares imported counts and key metadata against the source
- optional exporter for rollback confidence

Do not require permanent dual-write between backends in the first phase.

Migration rules:

- preserve workflow ids
- preserve publication metadata
- preserve last published timestamps
- preserve recordings and replay artifacts
- preserve relative folder structure logically in database form
- preserve rename/move semantics so published state and recordings still attach to the same workflow id after import

Status now:

- `DONE`: `wrapper/api/src/scripts/migrate-workflow-storage.ts` now implements both import and verification flows
- `DONE`: root and API package scripts now expose `workflow-storage:migrate` and `workflow-storage:verify`
- `DONE`: migration rehearsal has already succeeded against the managed stack with real source data, including workflows, publication state, recordings, and replay artifacts
- `DONE`: verification has already confirmed imported workflow counts, folder counts, and recording summaries after rehearsal
- `DONE`: verifier behavior is now understood operationally: it is a pre-cutover parity check and is expected to diverge once new managed-only executions or edits occur after cutover

### Cutover and rollback rules for phase 1

Do not leave cutover implicit.

Recommended cutover sequence:

1. freeze or coordinate writes in the source `filesystem` environment
2. back up the current host `workflows/` directory and relevant app data used by recordings
3. import workflows, sidecars, publication state, and recordings into the managed backend
4. run verifier checks for counts, statuses, endpoints, publication timestamps, and recording availability
5. switch the environment to `RIVET_STORAGE_MODE=managed`
6. run smoke checks for editor open/save, publish/unpublish, published execution, recordings list, and replay
7. keep the old host data as rollback input until the managed deployment is accepted

Rollback rule:

- rollback is a controlled environment switch back to `filesystem` mode with the preserved host data
- phase 1 should not rely on long-lived dual-write between `filesystem` and `managed`

Status now:

- `DONE`: the import plus verification portion of cutover has already been rehearsed on a managed prod-style Docker stack
- `DONE`: the old host `workflows/` tree remains the rollback input for this rehearsal path because managed mode imports rather than mutates the source tree
- `DONE`: the managed-mode smoke check after cutover has now succeeded, including editor open, managed save behavior, publish/execution, recording persistence, and the observable Playwright UI flow

### Phase 1 infrastructure decision

Phase 1 should assume the final target infrastructure from the beginning:

- managed `Postgres`
- managed `S3-compatible object storage`

That means phase 1 should build against the same kind of dependencies that production Kubernetes will use later, rather than first building around an in-cluster database that would later need to be replaced.

Practical development rule:

- local development remains fully supported through the `filesystem` backend
- the `managed` backend is for environments where shared services exist or are emulated locally for rehearsal

## Phase 1.1: Managed-Mode Latency Hardening

Phase 1 is not complete when managed mode is only functionally correct.

If editor actions that used to be local-folder operations become visibly slow after moving state to managed Postgres plus object storage, that latency must be treated as a Phase 1 gap, not deferred to Kubernetes work.

Measured warm-path baseline on the current managed implementation:

- direct Postgres round trip is roughly `145ms`
- direct object-storage GET is roughly `222ms`
- `GET /api/workflows/tree` is roughly `150-170ms`
- `POST /api/projects/load` is roughly `510-535ms`
- `PATCH /api/workflows/folders` rename is roughly `1460-1475ms`

Those numbers show that the main problem is not object storage itself. The main problem is too many remote database round trips in the managed code paths, plus avoidable UI waiting behavior.

#### Root causes to address in Phase 1.1

1. Folder rename is too round-trip-heavy in managed mode.

Current rename flow in `wrapper/api/src/routes/workflows/managed/backend.ts` does multiple serial database operations:

- source existence check
- target parent existence check
- target collision check
- affected workflow lookup for `movedProjectPaths`
- multiple update statements to perform the temporary-prefix move
- final row reload

With a remote database, that naturally stacks into more than one second of latency.

2. Project open does more sequential work than necessary.

Current managed load performs:

- one database query for the workflow row
- one database query for the revision row
- one object-storage GET for the project blob
- optional object-storage GET for the dataset blob

That already explains most of the measured backend latency before the editor finishes loading the project in the browser.

3. The UI still waits for a full tree refetch after folder rename.

The rename response already contains enough information to update the local tree immediately, but the current panel still waits for a follow-up `GET /api/workflows/tree`.

4. Managed project parsing still adds unnecessary UI delay.

The hosted editor should deserialize loaded projects off the main thread so network time and parse time do not combine into one large visible pause.

#### Required Phase 1.1 changes

1. Add latency visibility to the managed hot paths.

Add `x-duration-ms` response headers to:

- `GET /api/workflows/tree`
- `PATCH /api/workflows/folders`
- `POST /api/projects/load`
- optionally `POST /api/projects/save`

This is additive only. Response bodies do not change.

2. Reduce managed folder rename to the minimum practical number of database round trips.

Refactor the managed rename path so it uses:

- one preflight query that validates source, target parent, and collisions while collecting the affected workflow paths
- one mutation statement, ideally CTE-based, that performs the temporary-prefix move plus final rewrite and returns the final folder row

Do not keep a separate final reload query.

3. Reduce managed project load to one joined database lookup plus blob fetches.

Introduce a helper that joins the workflow row directly to its current draft revision so `loadHostedProject(...)` no longer performs two sequential database lookups for the common case.

4. Reuse object-storage connections explicitly.

Enable keep-alive on the S3-compatible client used by the managed blob store so warm-path project loads do not pay unnecessary connection churn.

5. Update the workflow tree optimistically after folder rename.

When rename succeeds:

- patch the current in-memory tree immediately from the mutation response
- remap expanded-folder ids
- remap project paths through the returned `movedProjectPaths`
- then run a non-blocking background refresh as reconciliation

The tree should not visually wait for the background fetch before showing the new name.

6. Move hosted project deserialization off the main thread for managed opens.

The hosted UI should use the existing worker-based deserialize path for project loads so the browser remains responsive while the project payload is parsed.

#### Phase 1.1 acceptance targets

Warm-path targets after startup:

- folder rename visible in the UI in under `600ms`
- `PATCH /api/workflows/folders` p95 under `500ms`
- `GET /api/workflows/tree` p95 under `200ms`
- `POST /api/projects/load` backend p95 under `400ms` for a small project without dataset payload
- opening a small project in the editor should feel sub-second end-to-end

Cold-start requests may still be slower because first connection setup to managed services is outside the hot path target for this subphase.

#### Phase 1.1 status

- `OPEN`: latency instrumentation for the managed workflow routes is not yet the standard acceptance surface
- `OPEN`: folder rename still spends too much time on remote database round trips
- `OPEN`: managed project load still does more sequential backend and browser work than necessary
- `OPEN`: the workflow tree still waits too long to reflect a successful rename
- `OPEN`: Phase 1 should not be considered complete until managed mode is both functionally correct and operationally responsive

## Phase 2: Runtime-Library Externalization And Replica-Safe Execution Support

After phase 1, externalize runtime-library distribution before Kubernetes.

The current `RIVET_RUNTIME_LIBS_HOST_PATH` model is acceptable only for single-host operation. It is not a safe long-term scaling contract for API or executor replicas.

### Phase 2 goals

- stop treating `RIVET_RUNTIME_LIBS_HOST_PATH` as the scalable runtime-library source of truth
- preserve backward-compatible local and single-host behavior for runtime libraries
- make runtime-library installs from the UI visible to every API and executor replica
- move runtime-library release metadata, activation state, and job ownership into shared infrastructure
- move built runtime-library release artifacts into object storage
- replace process-local install/remove job ownership and SSE assumptions with shared-state job coordination
- keep `require()` behavior stable for hosted `Code` nodes while making runtime-library propagation replica-safe

### Current runtime-library constraint

Today:

- the UI calls `/api/runtime-libraries/*`
- the API runs `npm install` into `RIVET_RUNTIME_LIBRARIES_ROOT`
- the active release lives under `current/node_modules`
- the API and executor both resolve packages from that local root

That works on one machine because both containers mount the same host path. It is not the right architecture for scaled replicas.

### Phase 2 runtime-library model

The target runtime-library model should mirror the workflow-storage model:

- Postgres stores runtime-library release metadata, package lists, activation pointers, and job records
- object storage stores immutable runtime-library release artifacts
- API and executor replicas materialize local read-only copies of the active release from those artifacts
- no shared RWX `node_modules` volume should be the source of truth

Recommended logical tables:

- `runtime_library_releases`
- `runtime_library_release_packages`
- `runtime_library_activation`
- `runtime_library_jobs`
- `runtime_library_job_logs`

Recommended object-storage artifacts:

- complete immutable release tarballs
- optional release metadata blobs if needed for audit/debugging

### Runtime-library backend contract

Phase 2 should introduce an explicit runtime-library backend selection:

- `RIVET_RUNTIME_LIBRARIES_BACKEND=filesystem|managed`

Meaning:

- `filesystem`
  - current host-path behavior
  - valid for backward compatibility, local development, and single-host deployments
- `managed`
  - release metadata and activation in Postgres
  - release artifacts in S3-compatible object storage
  - required for safe multi-replica backend execution

Compatibility rule:

- if `RIVET_RUNTIME_LIBRARIES_BACKEND=filesystem`, backend replica count must stay `1`
- if `RIVET_RUNTIME_LIBRARIES_BACKEND=filesystem`, backend HPA must stay disabled
- if backend execution is expected to scale safely, `RIVET_RUNTIME_LIBRARIES_BACKEND=managed` is required

Existing compatibility envs remain valid for `filesystem` mode:

- `RIVET_ARTIFACTS_HOST_PATH`
- `RIVET_RUNTIME_LIBRARIES_ROOT`
- `RIVET_RUNTIME_LIBS_HOST_PATH`

Managed runtime-library mode should reuse the existing external infrastructure shape:

- managed Postgres
- managed S3-compatible object storage

Recommended managed-mode env additions:

- `RIVET_RUNTIME_LIBRARIES_BACKEND=managed`
- `RIVET_RUNTIME_LIBRARIES_OBJECT_STORAGE_PREFIX=runtime-libraries/`

Design rule:

- runtime-library managed mode should reuse the same shared Postgres and object-storage services as workflow managed mode unless a future scaling reason requires separation

### Runtime-library install and remove flow in phase 2

The UI install/remove behavior can stay the same, but the backend execution model must change.

Recommended flow:

1. the UI submits an install or remove request to `/api/runtime-libraries/*`
2. an API replica writes a job row in Postgres
3. a dedicated builder worker or claimed control-plane worker executes the build
4. the build creates a complete candidate release, validates it, and uploads one immutable release artifact to object storage
5. a database transaction marks the new release as active
6. API and executor replicas reconcile to the new active release id
7. each replica downloads and extracts the release into a local cache path before using it

Required propagation rule:

- no replica should ever observe a half-installed release
- a workflow execution should pin one active runtime-library release id at the start of the run
- the next run can use the next active release, but an in-flight run must not switch releases mid-execution

### Runtime-library cache model on replicas

Replicas should not execute directly from object storage.

Recommended model:

- object storage holds the immutable release artifact
- each API or executor replica keeps a local extracted cache of active or recently used releases
- cache population happens by explicit reconciliation against the active release id
- old local caches can be garbage-collected after activation is stable

This keeps execution fast while preserving one shared source of truth.

### UI and observability expectations in phase 2

The current UI behavior should remain:

- install from the runtime-libraries modal
- observe logs/progress
- remove installed packages

But the implementation should no longer assume one in-memory job owner.

Phase 2 should move job visibility to shared state so that:

- the user can refresh the UI and still see the active job
- a different API replica can serve job status
- SSE or polling reflects a job that is not owned by the current process

### Kubernetes implications of phase 2

Phase 2 should eliminate the need for a shared authoritative runtime-libraries volume in Kubernetes.

After phase 2:

- runtime libraries should not require a shared `runtime-libraries` PVC as the authoritative source of truth
- pods may keep local runtime-library caches, but those caches are derived from shared state

This makes Kubernetes adoption in phase 3 much cleaner.

## Phase 3: Kubernetes Adoption

After phases 1 and 2, move the managed architecture onto Kubernetes.

At this point Kubernetes becomes much safer because the runtime no longer depends on host folders for authoritative workflow state or runtime-library truth.

### Phase 3 goals

- adopt the devops platform standard
- deploy the app on Kubernetes without reintroducing local-folder truth
- keep operational risk low while validating the new state model in-cluster
- keep Postgres and object storage outside the Kubernetes app chart as managed external services

### Repo structure required

Add at repo root:

- `image/`
- `charts/`
- `.gitlab-ci.yml`

### Images

Keep separate images for:

- `proxy`
- `web`
- `api`
- `executor`

All application containers should run as:

- uid `10001`
- gid `10001`

Kubernetes should deploy only:

- `proxy`
- `web`
- `api`
- `executor`

Kubernetes should not deploy:

- `Postgres`
- object storage

### Vault integration

Use the devops platform contract:

- Vault Injector writes `/vault/dotenv`
- `api`, `executor`, and `proxy` source `/vault/dotenv` in entrypoint
- `web` can remain build-time configured unless later runtime config is introduced

### Kubernetes workloads

Recommended phase-3 shape:

- `proxy` Deployment
- `web` Deployment
- `backend` StatefulSet or Deployment containing:
  - `api`
  - `executor`

Reason:

- workflow state no longer requires a `workflows` PVC
- runtime-library releases no longer require an authoritative shared `node_modules` volume
- plugin behavior and a few remaining backend paths still justify a conservative backend rollout initially
- external state services are already handled outside the cluster

### Storage in Kubernetes after phases 1 and 2

#### No authoritative `workflows` PVC

Do not carry the old model forward.

After phase 1 in Kubernetes:

- workflows should not live on a mounted `workflows` PVC as the runtime source of truth
- workflow state should come from Postgres and object storage

#### Remaining persistent storage

Keep persistent storage only where still needed:

- app data PVC if plugins or other local app state still require it
- optional per-pod cache storage if you do not want runtime-library release caches to live only in `emptyDir`

#### Ephemeral storage

- workspace can remain `emptyDir`

### Why backend should still start conservatively in phase 3

Even after workflow and runtime-library externalization, some backend concerns still remain process-local or operationally sensitive:

- latest debugger websocket state
- plugin install/load semantics
- any residual in-memory caches that still need replica-safe invalidation

So phase 3 should still begin conservatively:

- no backend HPA initially
- validate correctness first
- then scale only after those remaining stateful paths are redesigned

Database note:

- Postgres remains a single logical external service with one writable primary
- database HA/failover is handled by the managed Postgres platform, not by app-level HPA

## Phase 4: Execution Scale-Out

Phase 4 is where the app becomes truly high-scale.

### Phase 4 goals

- support many execution replicas safely
- isolate user-facing management traffic from public execution traffic
- keep published execution fast, stateless, and horizontally scalable

### Recommended architectural split

Split the backend logically into:

- `control plane`
  - dashboard/editor APIs
  - workflow management
  - publication
  - recordings UI
  - admin/runtime-library/plugin management
- `execution plane`
  - published workflow execution
  - optional latest-workflow execution if still supported

This split is strongly recommended if the target is thousands of requests per second.

### Execution behavior at scale

Execution replicas should:

- resolve endpoint -> published revision via Postgres or cached lookup
- fetch revision blobs from object storage
- execute without relying on pod-local workflow folders
- write recording metadata to Postgres
- write recording artifacts to object storage

Pods should be disposable.

No local workflow folder should matter.

### Coordination and caching

At higher scale, add:

- cache for endpoint-to-revision lookups
- cache invalidation or pub/sub on publish changes
- background job coordination for retention, cleanup, or artifact compaction

Use cache only as acceleration.

The source of truth remains:

- Postgres for metadata
- object storage for immutable blobs

## Why This Order Is Safer

State externalization first is safer than Kubernetes-first because it removes the biggest misconception:

- that local folders can remain the truth while replicas multiply

Once workflow, recording, and runtime-library state are on the managed backend:

- replicas do not need synchronized `workflows` folders
- replicas do not need synchronized `runtime-libraries` folders
- UI edits, publish actions, and runtime-library installs affect all replicas through shared infrastructure
- cutover to Kubernetes stops depending on special host-path assumptions

## DevOps Standard Alignment

The devops-standard repository shape still applies in phase 3:

- `image/`
- `charts/`
- `.gitlab-ci.yml`

The difference is that the chart and images should target the managed-state architecture, not the host-folder-based architecture.

The chart should reference external managed services for:

- `Postgres`
- `S3-compatible object storage`

The chart should not attempt to own their lifecycle.

## Helm Chart Values Contract

Root `charts/values.yaml` should define at least these sections:

```yaml
images:
  proxy:
    repository:
    tag:
    pullPolicy:
  web:
    repository:
    tag:
    pullPolicy:
  api:
    repository:
    tag:
    pullPolicy:
  executor:
    repository:
    tag:
    pullPolicy:

replicaCount:
  proxy: 1
  web: 1
  backend: 1

autoscaling:
  proxy:
    enabled: false
  web:
    enabled: false
  backend:
    enabled: false

service:
  proxy:
    port: 80
    targetPort: 8080
  web:
    port: 3000
    targetPort: 3000
  api:
    port: 80
    targetPort: 8080
  executor:
    port: 21889
    targetPort: 21889

ingress:
  enabled:
  className:
  host:
  externalDNSHostname:
  annotations: {}

vault:
  enabled: true
  tlsSkipVerify: false
  caSecretName:
  caCertPath: /vault/tls/ca.crt
  roleIdSecretName: vault-role-id
  dotenvFileName: dotenv
  dotenvTemplate: ""

workflowStorage:
  backend: managed

postgres:
  mode: managed
  host:
  port: 5432
  database:
  username:
  passwordSecretName:
  sslMode:

objectStorage:
  endpoint:
  bucket:
  region:
  accessKeySecretName:
  secretKeySecretName:
  forcePathStyle:

storage:
  appData:
    enabled: true
    size:
    storageClassName:

runtimeLibraries:
  backend: managed
  objectStoragePrefix: runtime-libraries/
  cache:
    enabled: false
    size:
    storageClassName:

tmpVolume:
  enabled: true
  name: var-tmp
  path: /var/tmp
  sizeLimit: 2Gi

env:
  RIVET_PUBLISHED_WORKFLOWS_BASE_PATH: /workflows
  RIVET_LATEST_WORKFLOWS_BASE_PATH: /workflows-latest
  RIVET_ENABLE_LATEST_REMOTE_DEBUGGER: "false"
  RIVET_REQUIRE_WORKFLOW_KEY: "true"
  RIVET_REQUIRE_UI_GATE_KEY: "true"
  RIVET_UI_TOKEN_FREE_HOSTS: ""
  RIVET_PROXY_RESOLVER: ""
  RIVET_COMMAND_TIMEOUT: "30000"
  RIVET_MAX_OUTPUT: "10485760"
  RIVET_RECORDINGS_ENABLED: "true"
  ...
resources:
  proxy: {}
  web: {}
  api: {}
  executor: {}
```

Rules:

- `workflowStorage.backend=filesystem` is allowed only for backward-compatible local or transitional deployments, not for the scaled Kubernetes target
- if `workflowStorage.backend=filesystem`, set `replicaCount.backend=1`
- if `workflowStorage.backend=filesystem`, keep `autoscaling.backend.enabled=false`
- `workflowStorage.backend=managed` is the target backend for Kubernetes adoption and scale-out
- `workflowStorage.backend=managed` assumes Postgres plus object storage as the workflow-state architecture
- `runtimeLibraries.backend=filesystem` is allowed only for backward-compatible single-host or single-backend-replica deployments
- `runtimeLibraries.backend=managed` is required before safe backend autoscaling
- `runtimeLibraries.backend=managed` assumes Postgres plus object storage as the runtime-library-state architecture
- `postgres.mode=managed` is the target production and Kubernetes setting
- `postgres.mode=local-docker` is allowed only for local development or non-production rehearsal
- do not add `workflows` as the authoritative runtime PVC in the managed architecture
- do not add a shared authoritative runtime-libraries PVC in the managed architecture
- the chart should configure connections to external managed `Postgres` and external managed object storage, not deploy them
- `autoscaling.backend.enabled` stays `false` until remaining process-local blockers are removed
- `proxy` and `web` can scale earlier than backend

## Environment Overlays

Use:

- `charts/overlays/test.yaml`
- `charts/overlays/prod.yaml`

These overlays must contain:

- ingress host and class
- Vault injector config
- storage backend selection
- runtime-library backend selection
- Postgres connection config references
- object storage config references
- remaining PVC sizes and storage classes
- replica counts if overridden
- autoscaling values if overridden
- image repositories/tags if needed
- environment-specific non-secret env values

Do not store secrets in overlays.

## Runtime Configuration Decisions

### Route prefixes

Keep:

- `/workflows`
- `/workflows-latest`

for phases 1, 2, and 3 unless runtime frontend config is added later.

### Ports

Keep:

- proxy on `8080`
- api on `8080`
- web on `3000`
- executor on `21889`

### Ingress

Ingress should:

- target only the `proxy` Service
- terminate TLS
- support websocket upgrades and long timeouts
- allow body size at least `100m`

### Database topology

Assume:

- one logical Postgres cluster
- one writable primary
- optional read replicas later if needed
- no HPA for Postgres

If connection count becomes an issue later, prefer a connection pooler such as PgBouncer rather than trying to scale Postgres like an app Deployment.

## Public APIs / Interfaces / Types

No user-facing published workflow route or top-level dashboard route change is required in the first step of the roadmap.

However, hosted editor internal IO is expected to change for `managed` mode. The current raw path-based hosted IO contract is not sufficient.

New operational interfaces introduced by the roadmap:

- `RIVET_STORAGE_MODE` selects the active workflow-and-recording storage backend
- `RIVET_DATABASE_MODE` selects whether the managed backend talks to local Docker Postgres or managed Postgres
- `RIVET_RUNTIME_LIBRARIES_BACKEND` selects the active runtime-library backend
- Postgres becomes the source of truth for workflow metadata and recordings index
- Postgres becomes the source of truth for runtime-library release metadata, activation state, and job coordination
- object storage becomes the source of truth for workflow, recording, and runtime-library artifacts
- managed `Postgres` and managed object storage are external infrastructure dependencies, not chart-owned workloads
- the current host `workflows/` directory remains valid in `filesystem` mode
- `filesystem` mode is supported only with a single backend replica and no backend autoscaling
- the current host `runtime-libraries/` directory remains valid in `filesystem` runtime-library mode
- `filesystem` runtime-library mode is supported only with a single backend replica and no backend autoscaling
- the current host `workflows/` directory becomes migration input in `managed` mode
- no authoritative `workflows` PVC should exist in the managed runtime architecture
- no authoritative runtime-libraries PVC should exist in the managed runtime architecture
- Kubernetes adoption happens after workflow/recording externalization and runtime-library externalization

New internal application interfaces introduced by phase 1:

- a workflow-aware hosted editor IO contract for list/open/save/save-as in `managed` mode
- virtual workflow references for hosted editor sessions instead of host filesystem paths
- database-backed conflict handling for save and publish operations
- adapter boundaries between catalog metadata, blob storage, and recording storage

New additive API/debug surface introduced by phase 1.1:

- `x-duration-ms` response headers on the managed workflow hot paths used for latency regression detection

New internal application interfaces introduced by phase 2:

- a runtime-library backend contract with `filesystem` and `managed` implementations
- replica-safe runtime-library release activation and reconciliation
- shared-state job ownership and job-log persistence for runtime-library install/remove operations
- local runtime-library release cache management derived from shared release artifacts rather than host-path truth

## Test Cases And Scenarios

### Phase 1: state externalization

1. Run the existing workflow feature suite in `filesystem` mode and confirm no behavior regression.
2. Import the current host `workflows/` directory into Postgres and object storage.
3. Verify project count, folder structure, endpoint mapping, publication status, and last-published timestamps match the source.
4. Verify recordings count and replay artifacts match the source.
5. Run the same workflow feature suite in `managed` mode and confirm parity with `filesystem` mode.
6. Run the `managed` mode test suite against local Docker Postgres and confirm parity.
7. Create a new workflow and confirm it appears correctly when read from the new shared state.
8. Edit an existing workflow and confirm the new draft revision is visible from another process instance.
9. Publish a workflow and confirm the published pointer changes atomically.
10. Confirm endpoint uniqueness no longer depends on filesystem scanning in `managed` mode.
11. Confirm recordings are written to Postgres plus object storage rather than local SQLite plus local bundle folders in `managed` mode.
12. Rename or move a workflow in `managed` mode and confirm workflow id, publication linkage, and recordings linkage remain stable.
13. Open, save, save-as, and reload a hosted project in `managed` mode and confirm the editor does not depend on raw `/api/native/*` workflow writes.
14. Save and reload datasets in `managed` mode and confirm dataset IO follows the managed workflow contract rather than `.rivet-data` file adjacency on host disk.
15. Simulate concurrent saves or publish-vs-save conflicts and confirm stale writers receive conflicts rather than silently overwriting newer revisions.
16. Confirm failed blob upload or failed database transaction cannot leave the workflow in a half-published state.

### Phase 1.1: managed-mode latency hardening

17. Measure warm-path managed latency and record a baseline for `GET /api/workflows/tree`, `PATCH /api/workflows/folders`, and `POST /api/projects/load`.
18. Confirm instrumented managed workflow routes emit `x-duration-ms` so latency regressions are visible without custom local profiling.
19. Rename a folder in managed mode and confirm the visible folder name updates immediately from the mutation response without the tree blanking or waiting on the follow-up refresh.
20. Confirm managed folder rename still preserves correct `movedProjectPaths`, workflow identity, publication linkage, and recording linkage.
21. Open a small managed project and confirm the backend path completes within the expected warm-path budget while the browser remains responsive during project deserialization.
22. Run the managed-mode Playwright flow after the latency changes and confirm the existing hosted-editor focus, clipboard, save, and tree-refresh behavior still works.

### Phase 2: runtime-library externalization

23. Run the runtime-library UI and API flows in `filesystem` mode and confirm no behavior regression for single-host operation.
24. Introduce `RIVET_RUNTIME_LIBRARIES_BACKEND=filesystem|managed` and confirm backward-compatible `filesystem` mode still works.
25. Install a runtime library in managed mode and confirm a complete immutable release artifact is created and stored in object storage.
26. Confirm runtime-library release metadata, active release pointer, and job state are written to Postgres rather than existing only in memory.
27. Confirm two separate API or executor processes can observe the same active runtime-library release without sharing a host path.
28. Confirm a newly activated release becomes available on the next workflow execution across replicas without a shared `node_modules` volume.
29. Confirm removal creates a new immutable release and that old in-flight executions can still finish against their pinned release.
30. Confirm job status survives UI refresh and can be observed from a different API replica.

### Phase 3: Kubernetes adoption

31. Deploy the managed-state version to a test namespace.
32. Confirm ingress serves `/`.
33. If UI gate is enabled, confirm gate login works.
34. Confirm editor iframe loads.
35. Confirm `/api/*` routes work only through proxy behavior.
36. Confirm executor websocket works through `/ws/executor/internal`.
37. Confirm latest debugger websocket works when enabled.
38. Confirm the workflow tree matches shared database state.
39. Restart backend pods and confirm no workflow or recording data is lost.
40. Scale `web` above `1` replica and confirm UI still works.
41. Scale `proxy` above `1` replica and confirm routing still works.
42. Confirm `filesystem` mode is rejected or documented as unsupported for backend replica count greater than `1`.
43. Confirm the app works against the managed Postgres service and managed object storage without in-cluster fallbacks.
44. Confirm runtime-library managed mode works in-cluster without a shared authoritative runtime-libraries PVC.

### Phase 4: scale-out

45. Confirm published execution works correctly across multiple execution replicas.
46. Confirm new publish operations become visible across replicas without filesystem refresh.
47. Confirm recording metadata and artifacts remain globally visible regardless of which pod executed the run.
48. Confirm runtime-library activation remains consistent across execution replicas under concurrent publish and execution load.
49. Confirm endpoint lookup remains correct under cache invalidation and concurrent publish changes.

### Vault and non-root

50. Deploy with Vault injection enabled and verify `/vault/dotenv` is present where expected.
51. Confirm all containers run as uid/gid `10001`.
52. Confirm no container requires privileged ports or root-only filesystem writes.

## Rollout Order

1. `DONE`: Introduce a workflow-storage abstraction and keep the current filesystem implementation working unchanged.
2. `DONE`: Add backend-selection config via `RIVET_STORAGE_MODE`.
3. `DONE`: Add database connection-mode config via `RIVET_DATABASE_MODE`.
4. Provision or secure access to the target managed Postgres service and managed S3-compatible object storage.
5. `DONE`: Set up local Docker Postgres and local S3-compatible storage for development and migration rehearsal.
6. `DONE`: Design the managed-mode hosted editor IO contract so open/save/save-as and dataset IO stop depending on raw host paths.
7. `DONE`: Implement the `managed` backend with Postgres plus S3-compatible object storage.
8. `DONE`: Refactor hosted editor IO so `managed` mode uses workflow-aware virtual references instead of `/api/native/*` workflow writes.
9. `DONE`: Build migration tooling from the current `workflows/` directory.
10. `DONE`: Run parity validation between `filesystem` and `managed` modes, including conflict handling and editor save/reload behavior.
11. `DONE`: Migrate existing workflow and recording state in a test environment.
12. `DONE`: Verify application behavior against the new shared state while still outside Kubernetes if useful.
13. Add route-level latency visibility for the managed workflow hot paths.
14. Reduce managed folder rename to the minimum practical number of remote database round trips.
15. Reduce managed project load to one joined database lookup plus blob fetches.
16. Reuse object-storage connections explicitly in the managed blob client.
17. Update the workflow tree locally on successful folder rename, then reconcile in the background.
18. Move managed hosted-project deserialization off the main thread.
19. Re-measure managed-mode rename and open latency and confirm Phase 1.1 acceptance targets.
20. Introduce a runtime-library backend abstraction with backward-compatible `filesystem` mode.
21. Implement managed runtime-library release metadata and activation state in Postgres.
22. Implement managed runtime-library release artifact storage in object storage.
23. Redesign runtime-library install/remove job ownership and job observability around shared state.
24. Validate that multiple API or executor processes can consume the same active runtime-library release without shared host paths.
25. Add `image/` Dockerfiles and entrypoints for the managed-state runtime.
26. Add `charts/` Helm chart and overlays.
27. Add `.gitlab-ci.yml` for the devops-standard deployment path.
28. Deploy the managed-state runtime to Kubernetes.
29. Validate in-cluster behavior with backend scaling still conservative.
30. Redesign remaining process-local paths.
31. Scale execution safely only after that redesign is complete.

## What Is Explicitly Out Of Scope For The First Phase

- using object storage alone without a shared database
- removing filesystem compatibility immediately
- trying to synchronize pod-local workflow folders
- backend autoscaling before remaining process-local paths are redesigned
- collapsing the app into one image
- removing nginx and going ingress-native
- runtime-configurable frontend route prefixes

## Assumptions And Defaults

- the current production `workflows/` directory contains data that must be preserved
- the long-term high-load concern is primarily workflow execution load
- managed Postgres is the shared metadata store
- managed S3-compatible object storage is the shared blob store
- the current host `workflows/` directory remains supported through the `filesystem` backend
- the current host `runtime-libraries/` directory remains supported only through the `filesystem` runtime-library backend
- the `filesystem` backend is supported only for single-backend-replica deployments
- the `filesystem` runtime-library backend is supported only for single-backend-replica deployments
- the managed backend is the target runtime architecture for Kubernetes and scale
- the default backend during transition is `filesystem`
- Kubernetes adoption comes after workflow/recording externalization and runtime-library externalization
- backend scale-out comes after Kubernetes adoption and after remaining process-local paths are redesigned
- proxy and web can scale earlier than the stateful backend paths
- all application containers should run as uid/gid `10001`


