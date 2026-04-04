# State Externalization, Kubernetes Adoption, and Scale-Out Plan

## Summary

The roadmap should start with state externalization, not Kubernetes.

Prepare the app in three deliberate phases:

1. `Phase 1`: introduce a storage abstraction with two backends, keep filesystem backward compatibility, and implement the managed backend
2. `Phase 2`: adopt Kubernetes on top of the managed-state architecture
3. `Phase 3`: scale the execution path for high-volume traffic

The reason for this order is simple:

- the current `workflows/` folder model is the biggest obstacle to shared truth across replicas
- Kubernetes does not solve shared state by itself
- once workflow and recording state live in shared infrastructure, Kubernetes becomes much safer and much more useful

The long-term goal remains the same: the app must eventually survive huge demand without relying on a single host machine or a single local folder tree.

Compatibility rule:

- the app should support both `filesystem` and `managed` workflow storage backends
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

- database is the source of truth for workflow metadata, folder tree, draft/published pointers, endpoint ownership, and recordings index
- object storage is the source of truth for large immutable artifacts such as project revisions, datasets, published snapshots, and recording bundles
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
- latest debugger state is process-local
- runtime-library job runner and SSE stream are process-local
- public workflow execution currently happens inside the API process

## Phase 1: Storage Abstraction And State Externalization

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

Add an env that selects the workflow storage backend:

- `RIVET_WORKFLOWS_STORAGE_BACKEND=filesystem|managed`

Recommended default during the transition:

- `filesystem`

Operational rule:

- when `RIVET_WORKFLOWS_STORAGE_BACKEND=filesystem`, backend replica count must stay `1`
- when `RIVET_WORKFLOWS_STORAGE_BACKEND=filesystem`, backend HPA must stay disabled

#### Filesystem backend envs

Keep the current envs for backward compatibility:

- `RIVET_WORKFLOWS_ROOT`
- `RIVET_WORKFLOWS_HOST_PATH`

#### Managed backend envs

The managed backend requires both database and object-storage configuration.

Use app-specific env names:

- `RIVET_WORKFLOWS_DATABASE_MODE=local-docker|managed`
- `RIVET_WORKFLOWS_DATABASE_URL`
- `RIVET_WORKFLOWS_DATABASE_SSL_MODE=disable|require|verify-full`
- `RIVET_WORKFLOWS_OBJECT_STORAGE_BUCKET`
- `RIVET_WORKFLOWS_OBJECT_STORAGE_REGION`
- `RIVET_WORKFLOWS_OBJECT_STORAGE_ENDPOINT`
- `RIVET_WORKFLOWS_OBJECT_STORAGE_ACCESS_KEY_ID`
- `RIVET_WORKFLOWS_OBJECT_STORAGE_SECRET_ACCESS_KEY`
- `RIVET_WORKFLOWS_OBJECT_STORAGE_PREFIX`
- `RIVET_WORKFLOWS_OBJECT_STORAGE_FORCE_PATH_STYLE`

Guidance:

- `RIVET_WORKFLOWS_DATABASE_MODE=local-docker` is allowed for development, migration rehearsal, and non-production validation
- `RIVET_WORKFLOWS_DATABASE_MODE=managed` is the target mode for Kubernetes production deployments
- `RIVET_WORKFLOWS_DATABASE_URL` is the runtime connection contract to the managed Postgres service
- `RIVET_WORKFLOWS_DATABASE_SSL_MODE=disable` is the normal default for local Docker Postgres
- `RIVET_WORKFLOWS_DATABASE_SSL_MODE=require` or stronger is the expected target for managed Postgres such as AWS RDS
- `RIVET_WORKFLOWS_OBJECT_STORAGE_ENDPOINT` is optional for AWS S3 and required for many S3-compatible vendors such as MinIO
- `RIVET_WORKFLOWS_OBJECT_STORAGE_FORCE_PATH_STYLE=true` is often needed for MinIO and some S3-compatible systems
- the official app contract should stay `RIVET_`-prefixed even if the implementation internally uses an AWS-compatible SDK

Example local `.env` for filesystem mode:

```dotenv
RIVET_WORKFLOWS_STORAGE_BACKEND=filesystem
RIVET_WORKFLOWS_HOST_PATH=../workflows
```

Example local `.env` for managed mode:

```dotenv
RIVET_WORKFLOWS_STORAGE_BACKEND=managed
RIVET_WORKFLOWS_DATABASE_MODE=local-docker
RIVET_WORKFLOWS_DATABASE_URL=postgres://user:password@localhost:5432/rivet
RIVET_WORKFLOWS_DATABASE_SSL_MODE=disable
RIVET_WORKFLOWS_OBJECT_STORAGE_BUCKET=rivet-workflows
RIVET_WORKFLOWS_OBJECT_STORAGE_REGION=eu-central-1
RIVET_WORKFLOWS_OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:9000
RIVET_WORKFLOWS_OBJECT_STORAGE_ACCESS_KEY_ID=minioadmin
RIVET_WORKFLOWS_OBJECT_STORAGE_SECRET_ACCESS_KEY=minioadmin
RIVET_WORKFLOWS_OBJECT_STORAGE_PREFIX=workflows/
RIVET_WORKFLOWS_OBJECT_STORAGE_FORCE_PATH_STYLE=true
```

Example production-style `.env` or secret wiring for managed mode:

```dotenv
RIVET_WORKFLOWS_STORAGE_BACKEND=managed
RIVET_WORKFLOWS_DATABASE_MODE=managed
RIVET_WORKFLOWS_DATABASE_URL=postgres://user:password@my-rds-host:5432/rivet
RIVET_WORKFLOWS_DATABASE_SSL_MODE=require
RIVET_WORKFLOWS_OBJECT_STORAGE_BUCKET=rivet-workflows
RIVET_WORKFLOWS_OBJECT_STORAGE_REGION=eu-central-1
# Endpoint can be omitted for AWS S3
RIVET_WORKFLOWS_OBJECT_STORAGE_ACCESS_KEY_ID=...
RIVET_WORKFLOWS_OBJECT_STORAGE_SECRET_ACCESS_KEY=...
RIVET_WORKFLOWS_OBJECT_STORAGE_PREFIX=workflows/
RIVET_WORKFLOWS_OBJECT_STORAGE_FORCE_PATH_STYLE=false
```

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

### Cutover and rollback rules for phase 1

Do not leave cutover implicit.

Recommended cutover sequence:

1. freeze or coordinate writes in the source `filesystem` environment
2. back up the current host `workflows/` directory and relevant app data used by recordings
3. import workflows, sidecars, publication state, and recordings into the managed backend
4. run verifier checks for counts, statuses, endpoints, publication timestamps, and recording availability
5. switch the environment to `RIVET_WORKFLOWS_STORAGE_BACKEND=managed`
6. run smoke checks for editor open/save, publish/unpublish, published execution, recordings list, and replay
7. keep the old host data as rollback input until the managed deployment is accepted

Rollback rule:

- rollback is a controlled environment switch back to `filesystem` mode with the preserved host data
- phase 1 should not rely on long-lived dual-write between `filesystem` and `managed`

### Phase 1 infrastructure decision

Phase 1 should assume the final target infrastructure from the beginning:

- managed `Postgres`
- managed `S3-compatible object storage`

That means phase 1 should build against the same kind of dependencies that production Kubernetes will use later, rather than first building around an in-cluster database that would later need to be replaced.

Practical development rule:

- local development remains fully supported through the `filesystem` backend
- the `managed` backend is for environments where shared services exist or are emulated locally for rehearsal

## Phase 2: Kubernetes Adoption

After phase 1, move the `managed` architecture onto Kubernetes.

At this point Kubernetes becomes much safer because the runtime no longer depends on a host folder for authoritative workflow state.

### Phase 2 goals

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

Recommended phase-2 shape:

- `proxy` Deployment
- `web` Deployment
- `backend` StatefulSet or Deployment containing:
  - `api`
  - `executor`

Reason:

- workflow state no longer requires a `workflows` PVC
- but runtime-library and plugin behavior still remain local enough that backend should stay conservative initially
- external state services are already handled outside the cluster

### Storage in Kubernetes after phase 1

#### No authoritative `workflows` PVC

Do not carry the old model forward.

After phase 1 in Kubernetes:

- workflows should not live on a mounted `workflows` PVC as the runtime source of truth
- workflow state should come from Postgres and object storage

#### Remaining persistent storage

Keep persistent storage only where still needed:

- app data PVC if plugins or other local app state still require it
- runtime libraries PVC if managed runtime-library releases still need local shared storage

#### Ephemeral storage

- workspace can remain `emptyDir`

### Why backend should still start conservatively in phase 2

Even after workflow state externalization, some backend concerns still remain process-local:

- latest debugger websocket state
- runtime-library install/remove job ownership
- runtime-library SSE streaming
- possibly plugin/runtime-library activation semantics

So phase 2 should still begin conservatively:

- no backend HPA initially
- validate correctness first
- then scale only after those remaining stateful paths are redesigned

Database note:

- Postgres remains a single logical external service with one writable primary
- database HA/failover is handled by the managed Postgres platform, not by app-level HPA

## Phase 3: Execution Scale-Out

Phase 3 is where the app becomes truly high-scale.

### Phase 3 goals

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

Once workflow and recording state are on the managed backend:

- replicas do not need synchronized `workflows` folders
- UI edits and publish actions affect all replicas through shared infrastructure
- cutover to Kubernetes stops depending on special host-path assumptions

## DevOps Standard Alignment

The devops-standard repository shape still applies in phase 2:

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
    enabled: true
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
- `postgres.mode=managed` is the target production and Kubernetes setting
- `postgres.mode=local-docker` is allowed only for local development or non-production rehearsal
- do not add `workflows` as the authoritative runtime PVC in the managed architecture
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
- workflow storage backend selection
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

for phase 1 and phase 2 unless runtime frontend config is added later.

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

- `RIVET_WORKFLOWS_STORAGE_BACKEND` selects the active workflow storage backend
- `RIVET_WORKFLOWS_DATABASE_MODE` selects whether the managed backend talks to local Docker Postgres or managed Postgres
- Postgres becomes the source of truth for workflow metadata and recordings index
- object storage becomes the source of truth for workflow and recording blobs
- managed `Postgres` and managed object storage are external infrastructure dependencies, not chart-owned workloads
- the current host `workflows/` directory remains valid in `filesystem` mode
- `filesystem` mode is supported only with a single backend replica and no backend autoscaling
- the current host `workflows/` directory becomes migration input in `managed` mode
- no authoritative `workflows` PVC should exist in the managed runtime architecture
- Kubernetes adoption happens after state externalization

New internal application interfaces introduced by phase 1:

- a workflow-aware hosted editor IO contract for list/open/save/save-as in `managed` mode
- virtual workflow references for hosted editor sessions instead of host filesystem paths
- database-backed conflict handling for save and publish operations
- adapter boundaries between catalog metadata, blob storage, and recording storage

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

### Phase 2: Kubernetes adoption

17. Deploy the managed-state version to a test namespace.
18. Confirm ingress serves `/`.
19. If UI gate is enabled, confirm gate login works.
20. Confirm editor iframe loads.
21. Confirm `/api/*` routes work only through proxy behavior.
22. Confirm executor websocket works through `/ws/executor/internal`.
23. Confirm latest debugger websocket works when enabled.
24. Confirm the workflow tree matches shared database state.
25. Restart backend pods and confirm no workflow or recording data is lost.
26. Scale `web` above `1` replica and confirm UI still works.
27. Scale `proxy` above `1` replica and confirm routing still works.
28. Confirm `filesystem` mode is rejected or documented as unsupported for backend replica count greater than `1`.
29. Confirm the app works against the managed Postgres service and managed object storage without in-cluster fallbacks.

### Phase 3: scale-out

30. Confirm published execution works correctly across multiple execution replicas.
31. Confirm new publish operations become visible across replicas without filesystem refresh.
32. Confirm recording metadata and artifacts remain globally visible regardless of which pod executed the run.
33. Confirm endpoint lookup remains correct under cache invalidation and concurrent publish changes.

### Vault and non-root

34. Deploy with Vault injection enabled and verify `/vault/dotenv` is present where expected.
35. Confirm all containers run as uid/gid `10001`.
36. Confirm no container requires privileged ports or root-only filesystem writes.

## Rollout Order

1. Introduce a workflow-storage abstraction and keep the current filesystem implementation working unchanged.
2. Add backend-selection config via `RIVET_WORKFLOWS_STORAGE_BACKEND`.
3. Add database connection-mode config via `RIVET_WORKFLOWS_DATABASE_MODE`.
4. Provision or secure access to the target managed Postgres service and managed S3-compatible object storage.
5. Set up local Docker Postgres and local S3-compatible storage for development and migration rehearsal.
6. Design the managed-mode hosted editor IO contract so open/save/save-as and dataset IO stop depending on raw host paths.
7. Implement the `managed` backend with Postgres plus S3-compatible object storage.
8. Refactor hosted editor IO so `managed` mode uses workflow-aware virtual references instead of `/api/native/*` workflow writes.
9. Build migration tooling from the current `workflows/` directory.
10. Run parity validation between `filesystem` and `managed` modes, including conflict handling and editor save/reload behavior.
11. Migrate existing workflow and recording state in a test environment.
12. Verify application behavior against the new shared state while still outside Kubernetes if useful.
13. Add `image/` Dockerfiles and entrypoints for the managed-state runtime.
14. Add `charts/` Helm chart and overlays.
15. Add `.gitlab-ci.yml` for the devops-standard deployment path.
16. Deploy the managed-state runtime to Kubernetes.
17. Validate in-cluster behavior with backend scaling still conservative.
18. Redesign remaining process-local paths.
19. Scale execution safely only after that redesign is complete.

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
- the `filesystem` backend is supported only for single-backend-replica deployments
- the managed backend is the target runtime architecture for Kubernetes and scale
- the default backend during transition is `filesystem`
- Kubernetes adoption comes after state externalization
- backend scale-out comes after Kubernetes adoption and after remaining process-local paths are redesigned
- proxy and web can scale earlier than the stateful backend paths
- all application containers should run as uid/gid `10001`
