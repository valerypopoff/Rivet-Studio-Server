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

Inside `Phase 2`, add a required `Phase 2.1` visibility pass:

- make runtime-library convergence visible across live replicas before relying on scaled endpoint execution
- treat replica-readiness visibility as part of runtime-library externalization quality, not as optional UI polish

Inside `Phase 2`, add a required `Phase 2.2` endpoint-performance pass:

- make managed published/latest endpoint execution use local derived caches on the warm path instead of repeated remote shared-state reads
- treat managed endpoint latency as part of shared-state execution quality, not as optional Phase 4 tuning

The reason for this order is simple:

- the current `workflows/` folder model is the biggest obstacle to shared truth across replicas
- the current runtime-library folder model is another source of host-local truth for code execution
- Kubernetes does not solve shared state by itself
- once workflow, recording, and runtime-library state live in shared infrastructure, Kubernetes becomes much safer and much more useful

The long-term goal remains the same: the app must eventually survive huge demand without relying on a single host machine or a single local folder tree.

Compatibility rule:

- the app should support both `filesystem` and `managed` workflow-and-recording storage backends during the transition
- the app should support both `filesystem` and `managed` runtime-library behavior during the transition, but storage mode selection should stay unified
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

## Current Checkpoint

Phases `1`, `1.1`, `2`, and `2.1` are now complete.

That means:

- workflows, recordings, and runtime-library releases can now use shared Postgres plus object storage as the authoritative backend
- managed runtime-library convergence is now visible across API and executor tiers
- the next live roadmap step is `Phase 2.2`: managed endpoint hot-path hardening on top of the managed-state architecture
- Kubernetes adoption remains the next step after that hardening pass closes

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

These parts still block safe backend autoscaling:

- latest debugger state is process-local
- public workflow execution currently happens inside the API process tier
- managed endpoint execution still pays shared-state lookup and revision materialization costs on the request path
- plugin install/load semantics and any remaining process-local caches still need replica-safe review
- `filesystem` mode remains single-backend-replica only by design

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
- `DONE`: Phase 1.1 latency hardening closed the remaining managed-mode performance gap, including route timing headers, reduced managed rename/load round trips, worker-based deserialize, and optimistic tree patching after rename

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

Guidance:

- `RIVET_DATABASE_MODE=local-docker` is allowed for development, migration rehearsal, and non-production validation
- `RIVET_DATABASE_MODE=managed` is the target mode for Kubernetes production deployments
- `RIVET_DATABASE_CONNECTION_STRING` is the runtime connection contract to the managed Postgres service
- `RIVET_DATABASE_SSL_MODE=disable` is the normal default for local Docker Postgres
- `RIVET_DATABASE_SSL_MODE=require` or stronger is the expected target for managed Postgres such as AWS RDS
- `RIVET_STORAGE_ENDPOINT` is optional for AWS S3 and required for many S3-compatible vendors such as MinIO
- `RIVET_STORAGE_FORCE_PATH_STYLE=true` is often needed for MinIO and some S3-compatible systems
- the official app contract should stay `RIVET_`-prefixed even if the implementation internally uses an AWS-compatible SDK
- retired aliases such as `RIVET_WORKFLOWS_STORAGE_*`, `RIVET_OBJECT_STORAGE_*`, and `RIVET_STORAGE_BACKEND` should fail fast instead of continuing to work silently

Example local `.env` for filesystem mode:

```dotenv
RIVET_ARTIFACTS_HOST_PATH=../
RIVET_STORAGE_MODE=filesystem
```

Example local `.env` for managed mode:

```dotenv
RIVET_STORAGE_MODE=managed
RIVET_DATABASE_MODE=local-docker
RIVET_DATABASE_CONNECTION_STRING=postgres://user:password@localhost:5432/rivet
RIVET_DATABASE_SSL_MODE=disable
RIVET_STORAGE_URL=http://127.0.0.1:9000/rivet-workflows
RIVET_STORAGE_ACCESS_KEY_ID=minioadmin
RIVET_STORAGE_ACCESS_KEY=minioadmin
RIVET_STORAGE_PREFIX=workflows/
RIVET_STORAGE_FORCE_PATH_STYLE=true
```

Example production-style `.env` or secret wiring for managed mode:

```dotenv
RIVET_STORAGE_MODE=managed
RIVET_DATABASE_MODE=managed
RIVET_DATABASE_CONNECTION_STRING=postgres://user:password@my-rds-host:5432/rivet
RIVET_DATABASE_SSL_MODE=require
RIVET_STORAGE_BUCKET=rivet-workflows
RIVET_STORAGE_REGION=eu-central-1
# Endpoint can be omitted for AWS S3
RIVET_STORAGE_ACCESS_KEY_ID=...
RIVET_STORAGE_ACCESS_KEY=...
RIVET_STORAGE_PREFIX=workflows/
RIVET_STORAGE_FORCE_PATH_STYLE=false
```

Status now:

- `DONE`: `.env.example` now documents the Phase 1 env surface for backend selection, database mode, and object-storage settings
- `DONE`: `ops/docker-compose.yml` and `ops/docker-compose.dev.yml` now pass the managed-backend envs into the `api` container
- `DONE`: `scripts/dev-docker.mjs` and `scripts/prod-docker.mjs` now auto-enable the `workflow-managed` compose profile when `RIVET_STORAGE_MODE=managed` and `RIVET_DATABASE_MODE=local-docker`
- `DONE`: local managed rehearsal services now exist in compose as `workflow-postgres`, `workflow-minio`, and `workflow-minio-init`
- `DONE`: the runtime and launcher config readers now fail fast when retired workflow/object-storage alias env names are still present

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

## Phase 1.1: Managed-Mode Latency Hardening - DONE

Phase 1 is not complete when managed mode is only functionally correct.

If editor actions that used to be local-folder operations become visibly slow after moving state to managed Postgres plus object storage, that latency must be treated as a Phase 1 gap, not deferred to Kubernetes work.

Measured warm-path baseline on the current managed implementation:

- direct Postgres round trip is roughly `145ms`
- direct object-storage GET is roughly `222ms`
- `GET /api/workflows/tree` is roughly `150-170ms`
- `POST /api/projects/load` is roughly `510-535ms`
- `PATCH /api/workflows/folders` rename is roughly `1460-1475ms`

Those numbers show that the main problem is not object storage itself. The main problem is too many remote database round trips in the managed code paths, plus avoidable UI waiting behavior.

Implemented Phase 1.1 result on the current DigitalOcean-backed dev stack:

- managed folder rename now uses one server-side mutation call backed by `move_managed_workflow_folder(...)`, not a serial client-side rename sequence
- managed project load now uses one joined workflow-plus-revision lookup plus blob reads
- hosted first-open now performs one `/api/projects/load` request
- switching to an already-open tab performs zero `/api/projects/load` requests
- managed project deserialize now runs in a worker and carries the attached Trivet payload needed by hosted mode
- the workflow tree patches a successful folder rename immediately and only reconciles in the background

Warm validation after implementation:

- warm `/api/projects/load` responses landed at `396ms` and `392ms`
- warm second-project open completed in `462ms` end-to-end
- tab switch added `0` extra `/api/projects/load` requests
- warm folder-rename backend timing landed at `481ms` on one run and `502ms` on another
- visible folder rename from the rename menu click landed at `593ms`

The remaining rename-backend variance is within a few milliseconds of the target and appears to be network jitter against the remote managed database, not a structural code gap in the route anymore.

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

3. The hosted open flow appears to load the same project more than once.

The current editor open path loads project contents in `useOpenWorkflowProject(...)`, then hands control to `useLoadProject(...)`, which can call the IO provider again for the same path in order to restore test data.

That means a single user-visible "open project" action is at risk of paying for:

- two `/api/projects/load` requests
- two project deserializations
- two dataset import passes

The same pattern also means switching to an already-open project tab can still trigger unnecessary IO instead of being a local state transition.

4. The UI still waits for a full tree refetch after folder rename.

The rename response already contains enough information to update the local tree immediately, but the current panel still waits for a follow-up `GET /api/workflows/tree`.

5. Managed project parsing still adds unnecessary UI delay.

The hosted editor should deserialize loaded projects off the main thread so network time and parse time do not combine into one large visible pause.

The current worker-based helper is not sufficient as-is, because it only returns the `Project` object. Hosted IO also needs the attached data payload so it can restore Trivet data correctly.

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

Protocol rule for this subphase:

- keep the existing `movedProjectPaths` response contract for compatibility with the current dashboard/editor bridge
- do not introduce a new folder-prefix move protocol in Phase 1.1 unless fresh profiling shows the compatibility response itself has become the dominant rename cost after the database round-trip reduction

3. Reduce managed project load to one joined database lookup plus blob fetches.

Introduce a helper that joins the workflow row directly to its current draft revision so `loadHostedProject(...)` no longer performs two sequential database lookups for the common case.

4. Eliminate duplicate project loads during open and tab switch.

Introduce an explicit "one remote load per project open" rule for hosted mode:

- opening a project that is not already open may perform one real managed load
- activating a project that is already open should be a local state switch and should not hit `/api/projects/load`

Required implementation shape:

- extend the opened-project session state so it can carry the loaded Trivet/test data needed by `useLoadProject(...)`
- update `useOpenWorkflowProject(...)` so it passes the initial load result through instead of discarding everything except `project`
- update `useLoadProject(...)` so it consumes preloaded test data when present and falls back to the IO provider only when that data is actually missing
- update the opened-project synchronization hook so the current project's Trivet state stays in sync with the stored opened-project entry, not just the project graph state

The goal is to make first open pay for one load and make tab switches local.

5. Reuse object-storage connections explicitly.

Enable keep-alive on the S3-compatible client used by the managed blob store so warm-path project loads do not pay unnecessary connection churn.

6. Update the workflow tree optimistically after folder rename.

When rename succeeds:

- patch the current in-memory tree immediately from the mutation response
- remap expanded-folder ids
- remap project paths through the returned `movedProjectPaths`
- then run a non-blocking background refresh as reconciliation

The tree should not visually wait for the background fetch before showing the new name.

7. Move hosted project deserialization off the main thread for managed opens.

The hosted UI should use a worker-based deserialize path for project loads so the browser remains responsive while the project payload is parsed.

Implementation rule:

- do not reuse the current helper unchanged if it only returns `Project`
- extend or replace the helper so it returns enough data for hosted IO to restore both the project and the attached Trivet payload
- apply the same worker path to recording replay project loads where possible so replay opens do not keep a separate slower parse path

#### Phase 1.1 acceptance targets

Warm-path targets after startup:

- folder rename visible in the UI in under `600ms`
- `PATCH /api/workflows/folders` p95 under `500ms`
- `GET /api/workflows/tree` p95 under `200ms`
- `POST /api/projects/load` backend p95 under `400ms` for a small project without dataset payload
- opening a small project in the editor should complete in under `800ms` end-to-end on the warm path
- one user action that opens a previously unopened project should result in at most one `/api/projects/load` request
- switching to an already opened project tab should result in zero `/api/projects/load` requests and should feel effectively instant

Cold-start requests may still be slower because first connection setup to managed services is outside the hot path target for this subphase.

#### Phase 1.1 status

- `DONE`: `x-duration-ms` response headers are present on the managed hot paths: workflow tree, folder rename, project load, and project save
- `DONE`: managed folder rename now runs through a server-side Postgres function plus path-prefix indexes instead of a serial client-side sequence of rename queries
- `DONE`: managed project load now uses a joined draft-revision lookup and explicit object-store keep-alive reuse
- `DONE`: hosted open now reuses session-cached Trivet payloads so first open does one managed load and tab switches do zero managed loads
- `DONE`: hosted project and replay deserialize now run in a worker path that preserves attached Trivet payloads
- `DONE`: the workflow tree reflects successful folder rename immediately and reconciles in the background without showing the loading placeholder
- `DONE`: managed mode is now both functionally correct and operationally responsive enough to close Phase 1.1, with rename timing fluctuating around the `500ms` backend target because the validation stack uses a remote public-network managed database

## Phase 2: Runtime-Library Externalization And Replica-Safe Execution Support - DONE

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

Current implementation status:

- `DONE`: the runtime-library API now goes through an explicit backend seam instead of one hard-wired in-memory filesystem path
- `DONE`: runtime libraries now follow `RIVET_STORAGE_MODE=filesystem|managed`, with `filesystem` preserved as the backward-compatible default
- `DONE`: managed mode now stores runtime-library release metadata, activation state, and job state in Postgres
- `DONE`: managed mode now stores immutable runtime-library release artifacts in object storage under the fixed `runtime-libraries/` prefix
- `DONE`: managed mode now uses shared-state job ownership and database-backed job logs, so refreshes and different API replicas can observe the same install/remove job
- `DONE`: managed runtime-library jobs now heartbeat and stale claimed jobs are failed automatically, so a crashed worker no longer leaves the system permanently stuck behind one active-job lock
- `DONE`: the API execution path now refreshes the local `current/` cache from managed state before hosted `Code` node execution resolves `require()`
- `DONE`: executor startup and code-node execution now reconcile managed releases independently through the bootstrap layer instead of depending on a shared authoritative runtime-library root mount
- `DONE`: API and executor execution now bypass the background sync throttle when checking for a newly activated release, so the next execution sees the latest active runtime-library state instead of waiting for the poll interval
- `DONE`: a real managed install job has now been exercised successfully against the managed Postgres plus object-storage backend, including artifact upload, release activation, API cache reconciliation, and executor cache reconciliation
- `DONE`: a real managed remove job has now been exercised successfully against the same backend, including activation of the empty release and cache cleanup in both the API and executor local roots
- `DONE`: the Phase 2 cleanup pass has now split the large managed backend, proxy-bootstrap sync, and runtime-library modal into smaller modules without changing behavior
- `DONE`: the public env/config contract is now canonicalized around `RIVET_STORAGE_*`, `RIVET_DATABASE_*`, `RIVET_ARTIFACTS_HOST_PATH`, and `RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS`; retired aliases now fail fast
- `DONE`: managed runtime-library audit/prune tooling now exists as `npm run runtime-libraries:managed:audit` and `npm run runtime-libraries:managed:prune`

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

Phase 2 should keep one shared storage-mode switch for both workflows and runtime libraries:

- `RIVET_STORAGE_MODE=filesystem|managed`

Meaning:

- `filesystem`
  - current host-path behavior
  - valid for backward compatibility, local development, and single-host deployments
- `managed`
  - release metadata and activation in Postgres
  - release artifacts in S3-compatible object storage
  - required for safe multi-replica backend execution

Compatibility rule:

- if `RIVET_STORAGE_MODE=filesystem`, backend replica count must stay `1`
- if `RIVET_STORAGE_MODE=filesystem`, backend HPA must stay disabled
- if backend execution is expected to scale safely, `RIVET_STORAGE_MODE=managed` is required

Existing compatibility envs remain valid for `filesystem` mode:

- `RIVET_ARTIFACTS_HOST_PATH`
- `RIVET_RUNTIME_LIBRARIES_ROOT`
- `RIVET_RUNTIME_LIBS_HOST_PATH`

Public contract rule:

- prefer `RIVET_ARTIFACTS_HOST_PATH` as the user-facing filesystem root
- treat `RIVET_RUNTIME_LIBRARIES_ROOT` and per-path host overrides as internal/advanced compatibility knobs, not the primary contract

Managed runtime-library mode should reuse the existing external infrastructure shape:

- managed Postgres
- managed S3-compatible object storage

Managed runtime-library artifacts use the fixed object-storage prefix:

- `runtime-libraries/`

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

## Phase 2.1: Runtime-Library Replica Readiness Visibility - DONE

Phase 2 is not complete when managed runtime-library propagation is only technically correct.

If the product expects a newly installed library to be usable for workflow execution through scaled endpoint traffic, the UI must also show whether the live runtime replicas have actually reconciled to the active runtime-library release.

Chosen product behavior for this subphase:

- show replica readiness in the existing `Runtime libraries` modal
- split readiness by tier:
  - `Endpoint execution`
  - `Editor execution`
- use app-observed healthy replicas as the denominator
- track only the currently active runtime-library release
- show aggregate counts by default with expandable per-replica details for debugging

Important current architecture rule:

- published and latest workflow endpoint execution currently run in the `api` process tier
- hosted editor/runtime execution currently uses the `executor` process tier
- therefore Phase 2.1 must report separate readiness for:
  - `endpoint` tier, currently backed by `api` replicas
  - `editor` tier, currently backed by `executor` replicas

### Why Phase 2.1 is required

Managed runtime-library releases now propagate safely through Postgres plus object storage, but the UI still cannot answer the key operational question:

- how many live replicas are actually ready to execute workflows with the current active runtime-library release?

Without that visibility:

- the user cannot tell whether a newly installed library is available everywhere
- partial convergence across replicas is invisible
- debugging scaled runtime-library failures becomes guesswork
- the UI implies a binary installed/not-installed state even though the real runtime is replica-based

### Phase 2.1 goals

- show live readiness counts for the current active runtime-library release
- make the denominator explicit and trustworthy
- distinguish endpoint-serving replicas from editor/runtime replicas
- make partial convergence and replica sync failures observable in the UI
- keep the first version Kubernetes-agnostic by relying on app-observed replica heartbeats instead of cluster API reads

Current implementation status:

- `DONE`: the managed runtime-library UI now shows `Replica readiness` with separate endpoint-tier and editor-tier counts
- `DONE`: API-process managed sync now reports endpoint-tier replica readiness through the existing bootstrap sync lifecycle, with just-in-time backend execution reusing that same process-level sync when available
- `DONE`: executor-process managed sync now reports editor-tier readiness through the existing executor bootstrap poller without adding a second reporting timer
- `DONE`: `GET /api/runtime-libraries` now exposes additive `replicaReadiness` state in managed mode and returns `null` in filesystem mode
- `DONE`: the runtime-libraries modal now exposes aggregate counts plus expandable per-replica detail for partial convergence and sync errors
- `DONE`: the modal now polls runtime-library state while open even when no install/remove job is active, so readiness stays current outside active jobs
- `DONE`: the modal now exposes a direct `Clear stale replicas` action so historical stale rows can be removed immediately without waiting for retention cleanup
- `DONE`: the runtime-libraries route remains observational; readiness aggregation reads persisted replica-status rows and does not itself trigger convergence
- `DONE`: managed runtime-library readiness reporting reuses the existing process-level managed sync lifecycle in API and executor containers instead of adding duplicate convergence pollers
- `DONE`: stale replica-status retention is now intentionally different by environment: `local-docker` keeps longer history for dev inspection, while `managed` defaults shorten stale-row noise and cleanup cadence

### Product surface

The first version should add a new `Replica readiness` section to the existing `Runtime libraries` modal.

Default view:

- `Endpoint execution replicas: X / Y ready`
- `Editor execution replicas: A / B ready`

Behavior rules:

- if all live replicas in a tier are ready, show success tone
- if some live replicas are still starting or syncing, show warning tone
- if any live replica is in an error state, show warning/error tone and make the details useful by default when expanded
- if a tier has no live replicas, show a neutral message instead of an error

Helper text:

- `Counts are based on replicas that reported within the last 30 seconds.`

Per-tier details should be collapsed by default and expandable on demand.

Each expanded replica row should show:

- display name
- current sync state
- last heartbeat age
- currently synced release id, when not ready for the active release
- last error message, when present

When an install/remove job is still running:

- keep showing readiness for the current active release
- add a note that counts reflect the currently active release and update after the new release is activated

UI rule:

- replica-readiness rendering must not depend on `activeJob` being present
- the readiness section should remain visible and update while the modal is open, even when no job is currently running
- when stale rows exist, the modal should expose a `Clear stale replicas` action that deletes only already-stale rows and then refreshes the readiness view

### Readiness model

A replica counts as `ready` for the active release only when:

- it is live by heartbeat
- it reported against the current active release id
- its local synced release id matches the active release id
- its sync state is `ready`

Do not store `stale` as a persisted state.

`stale` should be computed server-side when:

- `last_heartbeat_at` is older than the heartbeat TTL

Recommended heartbeat TTL:

- `max(syncPollIntervalMs * 3, 30_000ms)`

Empty-release rule:

- if the active release is empty and a replica has reconciled to that empty state, it still counts as `ready`
- readiness is about release convergence, not about whether any packages are currently installed

### Reporting safety rules

Replica-readiness reporting is an observability feature, not part of execution correctness.

Rules:

- a replica-status write failure must never block runtime-library reconciliation
- a replica-status write failure must never block endpoint execution or editor execution
- `GET /api/runtime-libraries` must remain a read-only reporting path and must not itself trigger local release reconciliation
- graceful row deletion on shutdown is best-effort only; heartbeat TTL remains the correctness backstop
- each process should run at most one readiness timer/poller for its own replica-status reporting

### Replica status table

Add a new Postgres table:

- `runtime_library_replica_status`

Recommended columns:

- `replica_id`
- `tier`
- `process_role`
- `display_name`
- `hostname`
- `pod_name`
- `target_release_id`
- `synced_release_id`
- `sync_state`
- `last_error`
- `last_sync_started_at`
- `last_sync_completed_at`
- `last_heartbeat_at`
- `created_at`
- `updated_at`

Design rules:

- one row represents one live process instance
- `tier` is product-facing:
  - `endpoint`
  - `editor`
- `process_role` is implementation-facing:
  - `api`
  - `executor`
- `replica_id` is a process-lifetime id, not a Kubernetes Deployment id

Process-role identification rule:

- because the process-level managed runtime-library sync runs in both API and executor containers, replica reporting needs an explicit process-role signal
- Phase 2.1 should add a small runtime env/config input such as `RIVET_RUNTIME_PROCESS_ROLE=api|executor`
- do not infer the role from argv or entrypoint filenames if an explicit env can be provided

### API-tier reporting requirements

Phase 2.1 must add readiness reporting for the managed API tier.

This is required because endpoint execution currently runs in the API process.

Current code already has two relevant managed sync paths in the API container:

- startup/runtime-library initialization in the API process
- the process-level proxy-bootstrap managed sync imported through `NODE_OPTIONS`
- the backend just-in-time `prepareForExecution()` path used before endpoint execution

Plan rule:

- do not introduce a second API-specific background convergence loop inside the managed backend just for readiness reporting
- instead, attach replica-status reporting to the existing process-level managed sync lifecycle that already runs in the API container
- keep `prepareForExecution()` forcing a just-in-time sync as a correctness backstop, and allow it to refresh replica status if it performs a sync outside the background path

Implementation rule:

- the process-level managed sync path should return a structured sync result that includes target release id, synced release id, sync state, timing, and error information
- both the process-level background sync path and the just-in-time `prepareForExecution()` path should use that same sync result to update replica status
- API startup reconciliation should remain the owner of initial managed runtime-library bootstrap for the process, rather than making modal polling the trigger
- `getState()` should aggregate persisted replica status only; it should not call into the sync path for readiness reporting beyond whatever one-time startup initialization the process already performs independently of the route

Lifecycle rule:

- the reporting hook must reuse the existing process-level managed sync timer rather than adding a second convergence timer for the same process
- `dispose()` must stop reporting and best-effort delete the process row

API reporting semantics:

- tier: `endpoint`
- process role: `api`
- display name: `HOSTNAME` when available, otherwise hostname/process-derived fallback

### Executor-tier reporting requirements

Executor managed sync already has a poll loop.

Extend it so executor replicas also write readiness status rows.

Executor reporting semantics:

- tier: `editor`
- process role: `executor`
- display name: `HOSTNAME` when available, otherwise hostname/process-derived fallback

Executor should:

- report `starting` at boot before first successful sync
- report `syncing` while reconciling to a new active release
- report `ready` after successful local reconciliation
- report `error` with the last sync error if reconciliation fails
- best-effort remove its own row on shutdown

Execution-safety rule:

- executor sync/reporting should treat replica-status writes as best-effort side effects
- if reporting the status row fails but local release reconciliation succeeds, executor execution must still proceed
- if the table does not exist yet, executor should log the reporting issue once and retry later without failing boot
- executor reporting should piggyback on the existing executor sync poller; do not add a second executor-only readiness timer

Schema-ownership rule:

- API backend owns the schema migration
- executor reporting should tolerate the table not existing yet and retry later instead of crashing boot

### Server-side aggregation contract

`GET /api/runtime-libraries` should gain a new additive field:

- `replicaReadiness`

The payload should include:

- `activeReleaseId`
- `heartbeatTtlMs`
- per-tier summaries for:
  - `endpoint`
  - `editor`

Each tier summary should expose:

- `liveReplicaCount`
- `readyReplicaCount`
- `staleReplicaCount`
- `replicas`

Each per-replica entry should expose:

- `replicaId`
- `tier`
- `processRole`
- `displayName`
- `hostname`
- `podName`
- `targetReleaseId`
- `syncedReleaseId`
- `syncState`
- `isReadyForActiveRelease`
- `lastHeartbeatAt`
- `lastSyncStartedAt`
- `lastSyncCompletedAt`
- `lastError`

Rules:

- `filesystem` mode returns `replicaReadiness: null`
- `managed` mode returns the readiness structure even when counts are zero
- stale replicas are excluded from the denominator and counted separately
- `replicas` should contain only live replicas for the tier; stale rows contribute to `staleReplicaCount` but are not mixed into the live detail list
- the readiness route is a reporting surface only; it must not become the mechanism that initializes or advances convergence on otherwise idle replicas

Aggregation rule:

- readiness is always computed against the currently active release from `runtime_library_activation`
- a replica that is still on the previous release remains live but not ready until it reports the new release
- sorting within a tier should prefer the most actionable rows first:
  - `error`
  - `syncing`
  - `starting`
  - `ready`

### Cleanup and retention

Replica-status rows should not accumulate forever.

Add a lightweight cleanup path that removes rows older than a retention window.

Implemented defaults:

- heartbeat TTL for liveness: `max(syncPollIntervalMs * 3, 30s)`
- `local-docker` stale-row cleanup threshold: `24h`
- `local-docker` cleanup cadence: every `15m`
- `managed` stale-row cleanup threshold: `15m`
- `managed` cleanup cadence: every `5m`
- an explicit operator cleanup path now exists at `POST /api/runtime-libraries/replicas/cleanup`, and the runtime-libraries modal can trigger it directly

### UI refresh strategy

Phase 2.1 should not rely on job SSE to keep readiness current.

Required behavior:

- while the modal is open in `managed` mode, poll `GET /api/runtime-libraries` on a fixed interval even when there is no active job
- keep job SSE only for high-frequency job-log and job-status updates
- avoid overlapping refresh loops that race each other; modal polling should become the single periodic refresh path, and SSE should update only the active job state
- modal polling must not be responsible for bootstrapping runtime-library sync on a replica; startup/process-level sync owns that lifecycle

Recommended default:

- modal readiness/state poll every `5s`

### Phase 2.1 acceptance targets

All of these acceptance targets are now met on the current managed implementation.

- the runtime-libraries modal shows endpoint-tier and editor-tier readiness counts in managed mode
- endpoint-tier counts reflect live API replicas
- editor-tier counts reflect live executor replicas
- the denominator excludes stale replicas instead of inflating the count forever
- a newly activated runtime-library release becomes visible as partial convergence until all live replicas report ready
- the modal exposes expandable per-replica details for debugging partial convergence or sync failures
- idle API replicas reconcile in the background so the endpoint-tier readiness count does not stay stale until traffic happens to hit each replica
- modal polling keeps readiness counts updating even when there is no active runtime-library job
- UI polling the runtime-libraries route does not itself make an idle API replica become ready; only the background/JIT sync paths may do that
- reporting-path failures degrade visibility only; they do not block real workflow execution
- Phase 2.1 does not add a second background convergence poller for API or executor processes; it reuses the existing managed sync lifecycle and layers reporting on top

### Phase 2.1 test scenarios

1. with one API replica and one executor replica in managed mode, the modal reports:
   - endpoint `1 / 1 ready`
   - editor `1 / 1 ready`
2. after activating a new runtime-library release, the modal shows a partial readiness state until both tiers finish reconciling
3. with multiple API replicas, the endpoint-tier denominator matches the number of live heartbeating API replicas, not the number of rows ever written historically
4. with one executor sync failure, the editor tier shows partial readiness and exposes the error in expanded details
5. if a replica stops heartbeating, it becomes stale, is excluded from the live denominator, and is counted separately
6. in `filesystem` mode, the modal does not show replica-readiness counts
7. existing runtime-library job logs, cancellation, and terminal result rendering still work while readiness polling is enabled
8. opening the runtime-libraries modal with no active job still updates readiness counts over time as replicas converge
9. polling `GET /api/runtime-libraries` against a managed API replica does not, by itself, trigger local cache reconciliation or artificially advance readiness
10. if replica-status writes fail while release sync succeeds, endpoint/editor execution still works and the failure is limited to readiness visibility
11. endpoint-tier reporting reuses the existing API process sync lifecycle instead of creating a second convergence timer
12. executor-tier reporting reuses the existing executor sync poller instead of creating a parallel readiness timer

## Phase 2.2: Managed Endpoint Hot-Path Hardening - DONE

After phase 2.1, harden managed published/latest endpoint execution before Kubernetes.

The app already has the correct shared-truth architecture for workflows, recordings, and runtime libraries.

That is not enough by itself.

If a trivial endpoint in `filesystem` mode returns in roughly `10ms` but the same endpoint in `managed` mode takes roughly `1000ms`, then the shared-state execution path is still paying the wrong costs on the request hot path.

Kubernetes does not fix that.

It would only replicate the same expensive request path across more pods.

### Why Phase 2.2 is required

Today the managed endpoint hot path still behaves like a cold shared-state read:

- resolve endpoint ownership in Postgres
- resolve the selected revision row in Postgres
- fetch the project blob from object storage
- fetch the dataset blob from object storage when present
- deserialize the project on demand before execution

That is structurally correct, but it is too expensive for the steady-state warm path.

The goal of Phase 2.2 is to preserve shared truth while making live managed endpoint execution feel like local execution for already-known revisions.

### Phase 2.2 goals

- make warm managed published endpoint execution fast enough to be comparable to `filesystem` mode for trivial no-code workflows
- make warm managed latest endpoint execution fast enough for normal product use without repeated shared-state round trips
- keep Postgres as the source of truth for endpoint ownership and revision pointers
- keep object storage as the source of truth for immutable revision blobs
- make publish/save/unpublish changes become visible across API replicas without waiting for TTL polling
- avoid reintroducing pod-local workflow truth or a shared authoritative workflow volume

### Phase 2.2 design

This subphase should add a local derived execution cache to each API replica.

That cache is acceleration only.

It is not a new source of truth.

Recommended internal cache layers:

- `EndpointPointerCache`
  - key: `runKind + normalizedEndpointName`
  - value: workflow id, relative path, chosen revision id, and project virtual path
- `RevisionMaterializationCache`
  - key: `revisionId`
  - value: immutable raw revision payload:
    - project contents
    - dataset contents

Implementation rules:

- cache raw revision text payloads, not shared mutable execution objects
- do not store mutable path metadata in the revision cache; current relative path and project virtual path must come from the live endpoint pointer because workflows can be renamed or moved without changing revision ids
- rebuild per-request `Project`, attached data, and `NodeDatasetProvider` from cached raw contents
- keep request isolation intact
- cache positive endpoint/reference resolutions only; do not cache `null` / not-found endpoint lookups in the first version
- deduplicate in-flight cold loads by endpoint key and revision id so concurrent warm-up requests share one database/blob fetch instead of stampeding Postgres and object storage
- bind endpoint-load singleflight to the current invalidation generation so a request that starts after a publish/save/unpublish does not accidentally inherit a stale in-flight miss or stale pre-invalidation pointer load
- if an invalidation lands while an endpoint load is already in flight, that in-flight load must detect the generation change, avoid repopulating pointer cache from pre-invalidation state, and retry from authoritative state before returning
- use a simple generation model:
  - one monotonic generation for any invalidation during the pre-query miss window when the workflow id is not known yet
  - one per-workflow generation after the resolved workflow id is known, so unrelated workflow mutations do not force retries on already-resolved endpoints
  - one clear-all generation for coarse invalidations such as folder-tree moves
  - prune old per-workflow generation bookkeeping after a safe retention window so long-lived replicas do not accumulate one entry per historically changed workflow forever
  - do not prune generation bookkeeping for workflows that currently have an active endpoint load, or the bookkeeping cleanup itself can look like a false mutation to an in-flight request
- on a cold miss, once the workflow id becomes known, use the recorded invalidation timestamps to distinguish "same workflow changed during this lookup" from "some unrelated workflow changed during this lookup" so unrelated churn does not force unnecessary retries
- keep object-storage reads parallel on a cache miss
- replace the current two-step managed endpoint lookup with one joined query that resolves endpoint ownership plus the chosen revision row together
- make managed project-reference loading reuse the same revision-materialization cache once a reference resolves to a revision; do not add a separate project-reference pointer cache in the first version unless later profiling proves it is needed
- once a referenced workflow resolves to a concrete workflow id, apply the same invalidation-aware retry rule during referenced revision materialization so a concurrent referenced-workflow change does not return stale referenced contents
- do not swallow real referenced-workflow load failures behind a generic "all hint paths failed" fallback once a hint path or workflow id has resolved to a real workflow row

### Cross-replica invalidation

Phase 2.2 should not rely on short polling or stale TTLs for correctness.

Recommended invalidation mechanism:

- use Postgres `LISTEN/NOTIFY`
- publish one transactional invalidation event whenever managed workflow mutation changes endpoint-serving state
- emit that invalidation from the database transaction itself, not from an application-side post-commit callback, so a process crash after commit cannot silently drop the event
- emit the invalidation only after the authoritative workflow rows and workflow-endpoint rows reflect the final committed state that should be served
- the same API process that commits a managed save/publish/unpublish/move/delete mutation must synchronously clear its own local endpoint-pointer entries for that workflow after commit succeeds and before returning the mutation response; `NOTIFY` is for every other replica
- API replicas keep one dedicated listener connection and invalidate local endpoint caches immediately when they receive a committed change event

The invalidation payload should stay minimal and be used for invalidation, not for clever cache rewrites.

The payload should include:

- workflow id
- event type

Mutation rules:

- no-op save emits no invalidation
- any real save, publish, unpublish, rename, move, delete, or import that changes endpoint-serving state invalidates all cached endpoint-pointer entries for that workflow
- folder-level moves or renames may clear the full endpoint-pointer cache in the first version instead of trying to enumerate every affected workflow id across replicas
- after invalidation, the next request repopulates from authoritative Postgres state
- `RevisionMaterializationCache` entries stay valid because revisions are immutable; only pointer entries need correctness-sensitive invalidation in the first version

### Failure and degradation rules

The cache must never become a correctness dependency.

Rules:

- if the invalidation listener is healthy, endpoint pointer cache entries remain valid until invalidated or evicted
- if the invalidation listener is disconnected, immediately clear endpoint-pointer cache entries, then bypass that pointer cache and do a real managed lookup on each request until the listener is healthy again
- while the listener is degraded, do not repopulate pointer caches from fallback database lookups; only resume pointer-cache population after a fresh healthy listener session is established
- when the listener reconnects, keep serving misses until the fresh listener session is fully established rather than trusting pointer entries created before the disconnect
- if repeated invalidations keep racing a single endpoint load, prefer retrying from authoritative state and eventually failing that one request over serving a stale cached revision
- revision materialization cache may still be reused while the pointer cache is bypassed
- degraded mode may be slower, but it must remain correct

### Bounded local cache policy

Phase 2.2 should keep the first version deliberately simple.

Recommended defaults:

- endpoint-pointer cache: LRU by entry count, default `4096`
- revision-materialization cache: LRU by total bytes, default `64 MiB`
- skip caching a single revision payload larger than `8 MiB`

Do not add public env knobs for these limits in the first pass unless real profiling proves they are needed operationally.

### Miss-path hardening

Even after caching, the cold miss path still matters after restart, publish, or pod churn.

Required miss-path improvements:

- one joined database lookup for endpoint -> workflow -> chosen revision row
- in-flight singleflight dedupe for the same endpoint key and the same revision id during cold-start or post-publish warm-up
- parallel blob reads for project and dataset
- do not add publish-time background prewarm in the first version; let the first post-invalidation request repopulate lazily unless profiling later proves prewarm is worth the complexity

### Runtime-library interaction rule

The primary target of Phase 2.2 is workflow-state lookup and revision materialization.

Do not block this subphase on redesigning runtime-library execution again.

For trivial workflows with no `Code` nodes, this subphase should assume runtime-library sync is not the dominant hot-path cost, because `ManagedCodeRunner.runCode(...)` is only invoked when a `Code` node executes.

If profiling still shows meaningful extra overhead on trivial no-code endpoint runs after the new execution cache lands, treat that as a follow-up optimization on top of Phase 2.2 rather than as a reason to delay the cache work.

### Phase 2.2 acceptance targets

- warm managed published endpoint p95 under `25ms` for a trivial no-code workflow with no project references and no datasets
- warm managed latest endpoint p95 under `35ms` for a trivial no-code workflow with no project references and no datasets
- warm managed published/latest endpoint execution for that trivial workflow class should not hit Postgres or object storage on the steady-state request path after the cache is populated
- first miss after pod start or after a new publish may still be slower, but should stay under `450ms` for a small workflow without datasets
- publish changes become visible across live API replicas without waiting for TTL polling
- save changes to a published workflow update the `latest` route across replicas without waiting for TTL polling
- `filesystem` mode behavior and latency remain unchanged

### Phase 2.2 test scenarios

1. call the same trivial managed published endpoint twice and confirm the second request is served from the warm cache path
2. call the same trivial managed latest endpoint twice with no save in between and confirm the second request is served from the warm cache path
3. save a published workflow in managed mode and confirm the `latest` route changes to the new draft revision while the published route still serves the published revision
4. publish a new revision in managed mode and confirm all live API replicas invalidate the old endpoint pointer and begin serving the new published revision
5. unpublish a managed workflow and confirm both published and latest routes stop resolving the old endpoint name
6. rename or move a published managed workflow and confirm endpoint execution still works and recordings continue attaching to the same workflow id
7. publish a managed workflow on one API replica and immediately hit the endpoint through that same replica; confirm it does not serve the stale pre-publish pointer before the listener callback arrives
8. hit a not-yet-published managed endpoint and get `404`, then publish that endpoint and confirm the next request succeeds instead of being trapped behind a cached miss
9. restart an API replica and confirm the first managed endpoint request can miss, but the second request becomes warm again
10. simulate invalidation-listener loss and confirm managed endpoint execution remains correct by clearing pointer caches and bypassing pointer-cache hits instead of serving stale data
11. restore the invalidation listener after a simulated disconnect and confirm the API process resumes normal warm pointer-cache behavior only after the fresh listener session is established
12. execute a workflow that references another managed workflow and confirm the second run does not refetch the same referenced revision blob, even if reference metadata is still resolved normally
13. send concurrent cold-start requests for the same managed endpoint and confirm they share one cold-load path instead of triggering duplicate blob downloads for the same revision
14. start a managed endpoint load, publish a new revision while that load is in flight, and confirm the in-flight request does not repopulate or return the stale pre-publish pointer
15. start loading a managed referenced workflow, publish or move that referenced workflow while the reference load is in flight, and confirm the reference load retries or fails rather than returning stale referenced contents
16. force a real managed referenced-workflow load failure after a hint path resolves and confirm the error surfaces as an operational load failure instead of being misreported as "all hint paths failed"
17. rerun the existing endpoint execution tests in `filesystem` mode and confirm there is no regression
18. confirm endpoint execution debug headers remain additive-only and are enabled only when the dedicated debug flag is on

## Phase 3: Kubernetes Adoption

After phases 1, 2, 2.1, and 2.2, move the managed architecture onto Kubernetes.

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

### Storage in Kubernetes after phases 1, 2, 2.1, and 2.2

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

At higher scale, extend the cache and coordination model introduced by Phase 2.2:

- endpoint-to-revision cache sizing and topology appropriate for a larger execution tier
- stronger invalidation or pub/sub on publish changes if Postgres `LISTEN/NOTIFY` is no longer sufficient by itself
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
- shared storage-mode selection for workflows and runtime libraries
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
- `RIVET_STORAGE_MODE` selects the active storage mode for both workflows and runtime libraries
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
- Kubernetes adoption happens after workflow/recording externalization, runtime-library externalization, and managed endpoint hot-path hardening

New internal application interfaces introduced by phase 1:

- a workflow-aware hosted editor IO contract for list/open/save/save-as in `managed` mode
- virtual workflow references for hosted editor sessions instead of host filesystem paths
- database-backed conflict handling for save and publish operations
- adapter boundaries between catalog metadata, blob storage, and recording storage

New additive API/debug surface introduced by phase 1.1:

- `x-duration-ms` response headers on the managed workflow hot paths used for latency regression detection

New internal application interfaces introduced by phase 1.1:

- opened-project session state must be able to carry the test-data payload needed for local tab switches without a second managed load
- worker-based hosted-project deserialize helpers must preserve attached data needed by hosted IO, not only the `Project` object

New internal application interfaces introduced by phase 2:

- a runtime-library implementation that follows the shared `filesystem` or `managed` storage mode contract
- replica-safe runtime-library release activation and reconciliation
- shared-state job ownership and job-log persistence for runtime-library install/remove operations
- local runtime-library release cache management derived from shared release artifacts rather than host-path truth

New additive API/debug surface introduced by phase 2.1:

- `GET /api/runtime-libraries` should expose per-tier replica readiness for the active runtime-library release in managed mode
- that readiness surface should be observational only and must not itself trigger replica reconciliation
- `POST /api/runtime-libraries/replicas/cleanup` should remove rows that are already stale so operators can clear historical readiness noise immediately

New operational config surface introduced by phase 2.1:

- an explicit process-role signal such as `RIVET_RUNTIME_PROCESS_ROLE=api|executor` so process-level managed sync can report readiness into the correct tier
- `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS` and `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS` tune how long stale rows are kept and how often background cleanup runs

New internal application interfaces introduced by phase 2.1:

- process-level replica-status reporting attached to the existing managed runtime-library sync lifecycle in API and executor processes
- an explicit process-role config surface so readiness reporting can distinguish `api` from `executor`
- server-side aggregation of live versus stale replica readiness by tier

New additive API/debug surface introduced by phase 2.2:

- managed endpoint execution routes should expose additive stage timing headers such as resolve/materialize/execute timing when `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true`
- those headers must stay debug-only and must not change normal endpoint response bodies or the existing `x-duration-ms` contract

New internal application interfaces introduced by phase 2.2:

- an API-process `EndpointPointerCache` for managed published/latest endpoint resolution
- an API-process `RevisionMaterializationCache` for immutable managed revision payloads
- a transactional Postgres invalidation event emitted from the database transaction itself plus a dedicated listener path for managed endpoint cache invalidation on save/publish/unpublish/move/delete
- a same-process post-commit pointer-cache invalidation step for the API process that performed the managed mutation
- in-flight singleflight dedupe for identical managed endpoint/reference cold loads so one revision miss does not fan out into repeated object-storage fetches

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
21. Open a small managed project and confirm the action results in at most one `/api/projects/load` request while the backend path completes within the expected warm-path budget.
22. Switch to an already-open project tab and confirm no `/api/projects/load` request is made for the tab switch.
23. Confirm the browser remains responsive during managed project deserialization and recording replay project opens.
24. Run the managed-mode Playwright flow after the latency changes and confirm the existing hosted-editor focus, clipboard, save, and tree-refresh behavior still works.

### Phase 2: runtime-library externalization

25. `DONE`: Run the runtime-library UI and API flows in `filesystem` mode and confirm no behavior regression for single-host operation.
26. `DONE`: Keep runtime-library behavior aligned to `RIVET_STORAGE_MODE=filesystem|managed` and confirm backward-compatible `filesystem` mode still works.
27. `DONE`: Install a runtime library in managed mode and confirm a complete immutable release artifact is created and stored in object storage.
28. `DONE`: Confirm runtime-library release metadata, active release pointer, and job state are written to Postgres rather than existing only in memory.
29. `DONE`: Confirm two separate API or executor processes can observe the same active runtime-library release without sharing a host path.
30. `DONE`: Confirm a newly activated release becomes available on the next workflow execution across replicas without a shared `node_modules` volume.
31. `DONE`: Confirm removal creates a new immutable release and that old in-flight executions can still finish against their pinned release.
32. `DONE`: Confirm job status survives UI refresh and can be observed from a different API replica.

### Phase 2.1: runtime-library replica readiness visibility - DONE

33. `DONE`: confirm the runtime-libraries modal shows separate readiness counts for:
   - endpoint execution replicas
   - editor execution replicas
34. `DONE`: confirm endpoint-tier readiness is derived from live API replicas, not from executor replicas
35. `DONE`: confirm editor-tier readiness is derived from live executor replicas
36. `DONE`: confirm stale replicas are excluded from the live denominator and counted separately
37. `DONE`: confirm a newly activated runtime-library release shows partial convergence until all live replicas report ready
38. `DONE`: confirm a replica sync failure appears in expanded per-replica details with an error state
39. `DONE`: confirm `filesystem` mode returns no replica-readiness surface in the modal
40. `DONE`: confirm the runtime-libraries modal still renders active-job logs, cancellation, and terminal status correctly while readiness polling is enabled

### Phase 2.2: managed endpoint hot-path hardening

41. Measure warm-path managed published and latest endpoint latency for a trivial no-code workflow with no project references and no datasets, and record a baseline against `filesystem` mode.
42. Confirm debug timing headers for managed endpoint execution are additive-only and appear only when the dedicated execution-debug flag is enabled.
43. Call the same managed published endpoint twice and confirm the second request is served from the warm local cache path.
44. Call the same managed latest endpoint twice with no save in between and confirm the second request is served from the warm local cache path.
45. Confirm warm managed published/latest endpoint execution for that trivial workflow class does not hit Postgres or object storage on the steady-state request path after the cache is populated.
46. Save a published managed workflow and confirm the `latest` route changes to the new draft revision while the published route still serves the published revision.
47. Publish a new managed revision and confirm live API replicas invalidate the old endpoint pointer and begin serving the new published revision without TTL polling.
48. Unpublish a managed workflow and confirm both published and latest routes stop resolving the old endpoint name immediately across replicas.
49. Publish a managed workflow on one API replica and immediately hit the endpoint through that same replica; confirm it does not serve the stale pre-publish pointer before the listener callback arrives.
50. Hit a not-yet-published managed endpoint and get `404`, then publish that endpoint and confirm the next request succeeds instead of being trapped behind a cached miss.
51. Restart an API replica and confirm the first managed endpoint request can miss, but the next request becomes warm again.
52. Simulate invalidation-listener loss and confirm managed endpoint execution stays correct by clearing pointer caches and bypassing pointer-cache hits rather than serving stale data.
53. Restore the invalidation listener after a simulated disconnect and confirm the API process resumes normal warm pointer-cache behavior only after the fresh listener session is established.
54. Execute a workflow that references another managed workflow and confirm the second run does not refetch the same referenced revision blob.
55. Start loading a managed referenced workflow, publish or move that referenced workflow while the reference load is in flight, and confirm the reference load retries or fails rather than returning stale referenced contents.
56. Force a real managed referenced-workflow load failure after a hint path resolves and confirm the error surfaces as an operational load failure instead of being misreported as "all hint paths failed".
57. Send concurrent cold-start requests for the same managed endpoint and confirm they share one cold-load path instead of triggering duplicate blob downloads for the same revision; then rerun the existing endpoint execution suite in `filesystem` mode and confirm there is no regression.

### Phase 3: Kubernetes adoption

58. Deploy the managed-state version to a test namespace.
59. Confirm ingress serves `/`.
60. If UI gate is enabled, confirm gate login works.
61. Confirm editor iframe loads.
62. Confirm `/api/*` routes work only through proxy behavior.
63. Confirm executor websocket works through `/ws/executor/internal`.
64. Confirm latest debugger websocket works when enabled.
65. Confirm the workflow tree matches shared database state.
66. Restart backend pods and confirm no workflow or recording data is lost.
67. Scale `web` above `1` replica and confirm UI still works.
68. Scale `proxy` above `1` replica and confirm routing still works.
69. Confirm `filesystem` mode is rejected or documented as unsupported for backend replica count greater than `1`.
70. Confirm the app works against the managed Postgres service and managed object storage without in-cluster fallbacks.
71. Confirm runtime-library managed mode works in-cluster without a shared authoritative runtime-libraries PVC.

### Phase 4: scale-out

72. Confirm published execution works correctly across multiple execution replicas.
73. Confirm new publish operations become visible across replicas without filesystem refresh.
74. Confirm recording metadata and artifacts remain globally visible regardless of which pod executed the run.
75. Confirm runtime-library activation remains consistent across execution replicas under concurrent publish and execution load.
76. Confirm endpoint lookup remains correct under cache invalidation and concurrent publish changes.

### Vault and non-root

77. Deploy with Vault injection enabled and verify `/vault/dotenv` is present where expected.
78. Confirm all containers run as uid/gid `10001`.
79. Confirm no container requires privileged ports or root-only filesystem writes.

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
13. `DONE`: Add route-level latency visibility for the managed workflow hot paths.
14. `DONE`: Reduce managed folder rename to the minimum practical number of remote database round trips.
15. `DONE`: Reduce managed project load to one joined database lookup plus blob fetches.
16. `DONE`: Eliminate duplicate managed project loads across first open and tab switches.
17. `DONE`: Reuse object-storage connections explicitly in the managed blob client.
18. `DONE`: Update the workflow tree locally on successful folder rename, then reconcile in the background.
19. `DONE`: Move managed hosted-project deserialization off the main thread with a worker contract that preserves attached data needed by hosted IO.
20. `DONE`: Re-measure managed-mode rename, open, and tab-switch latency and confirm Phase 1.1 acceptance targets.
21. `DONE`: Introduce a runtime-library backend abstraction with backward-compatible `filesystem` mode.
22. `DONE`: Implement managed runtime-library release metadata and activation state in Postgres.
23. `DONE`: Implement managed runtime-library release artifact storage in object storage.
24. `DONE`: Redesign runtime-library install/remove job ownership and job observability around shared state.
25. `DONE`: Validate that multiple API or executor processes can consume the same active runtime-library release without shared host paths.
26. `DONE`: Refactor managed runtime-library sync paths so they return structured sync outcomes that can be reused by process-level reporting and just-in-time execution checks.
27. `DONE`: Add an explicit process-role config surface for managed runtime-library reporting and attach endpoint-tier reporting to the existing API process sync lifecycle.
28. `DONE`: Add editor-tier reporting to the existing executor managed sync poller, keeping reporting failures non-blocking for execution.
29. `DONE`: Add read-only `GET /api/runtime-libraries` readiness aggregation for active-release convergence across live replicas.
30. `DONE`: Add runtime-libraries modal readiness counts and expandable per-replica details, with modal polling that works even when no job is active.
31. `DONE`: Validate replica-readiness visibility against partial convergence, stale replicas, sync-failure cases, and the guarantee that UI polling does not itself trigger sync.
32. Add managed endpoint execution timing visibility beyond the existing total-duration header.
33. Introduce an API-process managed endpoint pointer cache keyed by route kind plus normalized endpoint name.
34. Keep those pointer caches positive-only in the first version; do not cache managed endpoint misses / not-found results.
35. Introduce an API-process managed revision materialization cache keyed by immutable revision id.
36. Add in-flight singleflight dedupe for identical managed endpoint/reference cold loads so concurrent misses share one database/blob fetch.
37. Refactor managed endpoint resolution to use one joined database lookup for endpoint ownership plus the chosen revision row.
38. Keep project and dataset blob reads parallel on managed cache misses.
39. Add transactional Postgres invalidation events for managed endpoint-serving state changes on save/publish/unpublish/move/delete, emitted from the database transaction itself rather than from application post-commit hooks.
40. Add one dedicated managed endpoint-cache invalidation listener connection per API process, clear pointer caches on listener loss, and bypass pointer-cache hits until listener health is restored.
41. Add same-process post-commit pointer-cache invalidation logic for the API process that performed the managed mutation so it cannot briefly serve stale pointers before its own listener callback fires.
42. Invalidate endpoint-pointer cache entries at workflow granularity for any managed mutation that changes endpoint-serving state; keep immutable revision payloads cached.
43. Reuse managed revision-materialization caching for referenced-project loading during endpoint execution without adding a separate reference-pointer cache in the first version.
44. Re-measure warm managed published/latest endpoint latency and confirm the Phase 2.2 acceptance targets before Kubernetes work begins.
45. Add `image/` Dockerfiles and entrypoints for the managed-state runtime.
46. Add `charts/` Helm chart and overlays.
47. Add `.gitlab-ci.yml` for the devops-standard deployment path.
48. Deploy the managed-state runtime to Kubernetes.
49. Validate in-cluster behavior with backend scaling still conservative.
50. Redesign remaining process-local paths.
51. Scale execution safely only after that redesign is complete.

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
- Kubernetes adoption comes after workflow/recording externalization, runtime-library externalization, and managed endpoint hot-path hardening
- backend scale-out comes after Kubernetes adoption and after remaining process-local paths are redesigned
- proxy and web can scale earlier than the stateful backend paths
- all application containers should run as uid/gid `10001`
- runtime-library replica-readiness visibility is part of Phase 2 quality, not optional polish
- managed endpoint hot-path hardening is part of Phase 2 quality, not optional Phase 4 polish
- endpoint-execution readiness currently maps to the `api` process tier because published/latest endpoint execution still runs there today
- editor-execution readiness currently maps to the `executor` process tier
- replica-readiness denominator should use app-observed healthy replicas, not Kubernetes desired replica count
- the first replica-readiness UI surface belongs in the existing runtime-libraries modal
- replica readiness should track only the currently active runtime-library release in the first version
- the existing process-level managed runtime-library sync in API and executor containers should remain the convergence mechanism, and Phase 2.1 should layer reporting onto it rather than create duplicate convergence timers
- `GET /api/runtime-libraries` must remain a read-only visibility surface rather than a hidden sync trigger
- managed endpoint execution caches are local derived acceleration only; Postgres and object storage remain authoritative
- managed endpoint cache invalidation should use transactional Postgres `LISTEN/NOTIFY` before Kubernetes rollout rather than short TTL polling
- the API process that commits a managed mutation should also synchronously clear its own pointer caches after commit succeeds instead of waiting for its own async notification callback
- the first managed endpoint cache should be positive-only; do not cache `404` / not-found endpoint lookups in the initial version
- the first managed endpoint cache should invalidate at workflow granularity when endpoint-serving state changes; narrower per-route repointing is a later optimization only if needed
- published execution is the highest-priority managed endpoint hot path, but latest execution should also become warm-path local after cache population
- the warm latency target is defined first for a trivial managed workflow with no `Code` nodes, no project references, and no datasets
- runtime-library sync is not expected to dominate that trivial-workflow hot path because `ManagedCodeRunner.runCode(...)` is only reached when a `Code` node executes
