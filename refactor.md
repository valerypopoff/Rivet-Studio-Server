# Comprehensive Post-Kubernetizing Consolidation Refactor

## Summary

This refactor should aggressively consolidate the codebase around the architecture that now actually exists:

- managed shared state is the primary production architecture
- Kubernetes is managed-only and keeps `backend` singleton
- published endpoint load belongs to the `execution` plane
- filesystem mode remains for compatibility, migration, and local fallback

The goal is not more features. The goal is to make the current system obvious, smaller, safer, and easier to hand to another engineer.

Success criteria:

- no external behavior changes
- materially less code in the remaining orchestration hotspots
- fewer god files mixing transport, business logic, state orchestration, and infrastructure
- clearer ownership boundaries between control plane, execution plane, runtime-library management, filesystem compatibility, and UI orchestration
- lower bug surface from fewer module-scoped side effects and less duplicated logic
- docs and tests reflect the new structure, not the legacy transition structure

Non-goals:

- no new product behavior
- no workflow semantics changes
- no HTTP, websocket, or Helm contract expansion
- no Kubernetes topology change
- no backend scale-out redesign
- no distributed debugger work
- no React state-library migration
- no database schema redesign unless a purely internal rename is unavoidable
- no cross-domain "managed platform" base class or generic persistence framework

Three compatibility boundaries must remain explicit throughout the refactor:

1. `filesystem` vs `managed` workflow storage
2. control-plane backend vs execution-plane backend
3. runtime-library job-worker mode vs sync-only mode

## Anti-Complexity Guardrails

These rules apply to every workstream. The refactor is only successful if it removes complexity instead of redistributing it.

- Prefer domain-local helpers over generic helper frameworks.
- Prefer composition roots plus plain modules over inheritance or service-locator patterns.
- Do not extract a helper unless it removes real branching or duplicated state transitions.
- Do not hide compatibility boundaries behind abstract interfaces that make the architecture harder to read.
- Keep public facades thin, but do not force every internal function behind an interface.
- Keep Helm helper extraction shallow. Reused blocks are good; template mazes are not.
- Treat file-size budgets as warning lights, not goals to hit by inventing wrappers.
- If a refactor introduces more concepts than it removes, reject that shape and simplify again.

## Important Public APIs / Interfaces / Types

### External contracts: unchanged

These must remain behaviorally identical:

- `POST /workflows-latest/:endpointName`
- `POST /workflows/:endpointName`
- `POST /internal/workflows/:endpointName`
- `GET /api/config`
- `WS /ws/latest-debugger`
- existing env var names
- existing Helm values surface
- existing Docker/Kubernetes launcher entrypoints
- existing filesystem and managed mode semantics
- `prepareForExecution()` and managed runtime-library sync behavior
- `globalThis.__RIVET_PREPARE_RUNTIME_LIBRARIES__`

### Internal additions and reorganizations

Add internal-only seams and make them the new implementation boundaries:

- `wrapper/api/src/routes/workflows/managed/context.ts`
  - `ManagedWorkflowContext`
- `wrapper/api/src/routes/workflows/managed/db.ts`
  - workflow-managed query helpers and retry wrapper
- `wrapper/api/src/routes/workflows/managed/transactions.ts`
  - `TransactionHooks`, transaction runner, rollback/commit hook utilities
- `wrapper/api/src/routes/workflows/managed/mappers.ts`
  - row mappers, shared SQL column constants, data-shaping helpers
- `wrapper/api/src/routes/workflows/managed/revision-factory.ts`
  - revision/blob-key construction and cleanup scheduling
- `wrapper/api/src/routes/workflows/managed/endpoint-sync.ts`
  - endpoint ownership sync and invariant helpers
- `wrapper/api/src/routes/workflows/recordings-store.ts`
  - explicit filesystem recording storage manager replacing module-scoped queue/state

- `wrapper/api/src/runtime-libraries/managed/context.ts`
  - `ManagedRuntimeLibrariesContext`
- `wrapper/api/src/runtime-libraries/managed/job-store.ts`
- `wrapper/api/src/runtime-libraries/managed/job-stream.ts`
- `wrapper/api/src/runtime-libraries/managed/job-worker.ts`
- `wrapper/api/src/runtime-libraries/managed/artifact-activation.ts`
- `wrapper/api/src/runtime-libraries/managed/process-registry.ts`
- `wrapper/api/src/runtime-libraries/managed/replica-status.ts`

- `wrapper/web/dashboard/useWorkflowLibraryController.ts`
- `wrapper/web/dashboard/useRunRecordingsController.ts`
- `wrapper/web/dashboard/useProjectSettingsActions.ts`
- `wrapper/web/dashboard/runtimeLibrariesJobStream.ts` (extracted from existing `useRuntimeLibrariesModalState.ts`, not a replacement)
- `wrapper/web/dashboard/useDashboardSidebar.ts`
- `wrapper/web/dashboard/useEditorBridgeEvents.ts`
- `wrapper/web/dashboard/apiRequest.ts`
- `wrapper/web/overrides/hooks/remoteExecutorProtocol.ts`
- `wrapper/web/overrides/hooks/remoteExecutionSession.ts`
- `wrapper/web/overrides/hooks/remoteDebuggerClient.ts`
- `wrapper/web/overrides/hooks/remoteDebuggerDatasets.ts`

- `charts/templates/_env.tpl`
- `charts/templates/_pod.tpl`

No new public types should leak outside these internals.

## Refactor Workstreams

### 1. Managed workflow backend: finish the split around real infrastructure seams

**Target files**

- `wrapper/api/src/routes/workflows/managed/backend.ts`
- `wrapper/api/src/routes/workflows/managed/catalog.ts`
- `wrapper/api/src/routes/workflows/managed/revisions.ts`
- `wrapper/api/src/routes/workflows/managed/recordings.ts`
- `wrapper/api/src/routes/workflows/managed/publication.ts`
- `wrapper/api/src/routes/workflows/managed/execution-service.ts`
- `wrapper/api/src/routes/workflows/managed/execution-invalidation.ts`
- `wrapper/api/src/routes/workflows/managed/execution-cache.ts`
- `wrapper/api/src/routes/workflows/managed/execution-types.ts`

**Existing files to preserve as-is (not split, only imported from)**

- `wrapper/api/src/routes/workflows/managed/types.ts` — shared types including `TransactionHooks`, `WorkflowRow`, `RecordingRow`, etc.
- `wrapper/api/src/routes/workflows/managed/blob-store.ts` — S3 blob store (text-based: `putText`/`getText`) plus blob-key factories

**Complexity to remove**

- one file currently owns facade wiring, DB retry logic, transaction orchestration, row mapping, blob cleanup, revision creation, and endpoint sync
- service constructors currently receive large callback bundles rather than one explicit context
- execution invalidation and cache infrastructure are tightly coupled to backend wiring but are not represented as a first-class seam
- bidirectional dependency chain: ExecutionService → ExecutionInvalidationController → ExecutionCache callbacks — this wiring order is implicit and easy to break

**Implementation substeps**

1. Create `managed/context.ts`.
   - Define `ManagedWorkflowContext` as the shared dependency container for workflow-managed modules.
   - Put `pool`, `blobStore`, `executionCache`, `executionInvalidationController`, and shared helper modules on the context.
   - Do not make it a service locator with lazy lookup logic; it should be plain data plus small helper references.
   - Document and enforce the initialization order: (1) blobStore.initialize, (2) DB schema init via withManagedDbRetry, (3) executionInvalidationController.initialize.
   - Document and enforce the disposal order: (1) mark disposed, (2) executionInvalidationController.dispose, (3) executionCache.clearRevisionMaterializations, (4) pool.end.
   - Enforce the execution infrastructure wiring order: (1) create executionCache, (2) create executionInvalidationController with cache invalidation callbacks, (3) create executionService with both cache and controller.

2. Create `managed/db.ts`.
   - Move `withManagedDbRetry`, retry constants, `queryRows`, and `queryOne` out of `backend.ts`.
   - Keep these helpers workflow-managed-specific. Do not create a shared API/runtime-library DB layer yet.
   - Export exactly the helpers needed by workflow-managed services.
   - Document that `withManagedDbRetry` is a public contract consumed by `execution-invalidation.ts`. Its retry codes (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`) and attempt count (3) are part of the contract.

3. Create `managed/transactions.ts`.
   - Move `#connectWithRetry`, `#withTransaction`, and transaction runner logic out of `backend.ts`.
   - Import `TransactionHooks` from the existing `managed/types.ts` — do not redefine the type.
   - Keep rollback and commit task ordering identical to the current implementation.
   - Document the execution order contract: `onRollback` tasks run if the transaction fails, `onCommit` tasks run after successful COMMIT. Blob cleanup is scheduled via `onRollback` to prevent orphaned objects. Execution invalidation is scheduled via `onCommit` to prevent premature cache updates. This ordering is correctness-critical.
   - Preserve best-effort cleanup logging semantics.

4. Create `managed/mappers.ts`.
   - Move `WORKFLOW_COLUMNS`, `WORKFLOW_COLUMNS_QUALIFIED`, `RECORDING_COLUMNS`, `toIsoString`, `getWorkflowStatus`, `mapWorkflowRowToProjectItem`, `mapFolderRowToFolderItem`, and `splitCurrentDraftRevisionRow`.
   - Keep `normalizeWorkflowEndpointLookupName` usage and status semantics identical.
   - Keep table-qualified constants explicit rather than deriving them dynamically at runtime.

5. Create `managed/revision-factory.ts`.
   - Move revision ID/blob-key creation, blob upload, insert, and rollback cleanup helpers out of `backend.ts`.
   - Keep the current cleanup behavior identical for partial upload failures.
   - Keep revision creation workflow-local; do not merge recording blob helpers into the same module if the resulting module becomes mixed-purpose.

6. Create `managed/endpoint-sync.ts`.
   - Move `#syncWorkflowEndpointRows` and related endpoint ownership checks out of `backend.ts`.
   - Keep endpoint conflict detection explicit.
   - Preserve current lookup-name normalization and ownership invariants.

7. Refactor `ManagedWorkflowExecutionService`.
   - Replace the current callback-heavy dependency bundle with `ManagedWorkflowContext` plus a small execution-specific adapter where needed.
   - Keep `execution-cache.ts` and `execution-invalidation.ts` as explicit infrastructure modules.
   - Do not generalize invalidation snapshots or retry logic beyond workflow execution.

8. Refactor `ManagedWorkflowBackend`.
   - Convert `backend.ts` into a composition root that builds the context and domain services.
   - Preserve the public method surface exactly.
   - Keep lifecycle methods `initialize()` and `dispose()` in the facade.

9. Run an anti-complexity review before finishing the phase.
   - Reject any helper that only forwards one existing method.
   - Reject any "base service" abstraction spanning catalog, revisions, publication, and recordings.
   - Verify no circular imports exist in the new module graph. The dependency order must be: `types.ts` → `mappers.ts`/`db.ts` → `transactions.ts` → domain services → `context.ts` → `backend.ts` facade.

**Required result**

- `managed/backend.ts` is mostly wiring and interface exposure, not mixed infra plus orchestration
- no workflow-managed service knows more than its explicit context and domain concern
- no duplicated row mapping or blob-cleanup logic remains across workflow-managed modules
- execution-service dependencies become stable, explicit infrastructure seams instead of callback bundles
- invalidation and cache logic remain readable and local to workflow execution, not generalized across unrelated backends

**Risks**

- transaction hook ordering is correctness-sensitive; moving it can silently break cleanup timing
- execution invalidation snapshots are race-sensitive; over-abstracting them can introduce stale endpoint bugs
- context objects can become hidden service locators if they grow without discipline
- merging revision and recording blob helpers too aggressively can create a new mixed-purpose module instead of reducing complexity

### 2. Managed runtime libraries: split the next backend monster without inventing a new platform layer

**Target files**

- `wrapper/api/src/runtime-libraries/managed/backend.ts`
- `wrapper/api/src/runtime-libraries/managed/schema.ts`
- `wrapper/api/src/runtime-libraries/managed/state.ts`
- `wrapper/api/src/runtime-libraries/managed/local-cache.ts`
- `wrapper/api/src/runtime-libraries/managed/release-builder.ts`

**Existing files to preserve as-is (not split, only imported from)**

- `wrapper/api/src/runtime-libraries/managed/blob-store.ts` — S3 blob store (binary-based: `putBuffer`/`getBuffer`) plus list/delete helpers and blob-key factories
- `wrapper/api/src/runtime-libraries/managed/cleanup.ts` — audit/retention/prune pipeline (491 lines). This file orchestrates across releases, jobs, and artifacts for retention policy enforcement. Keep it as a separate orchestrator; do not split it across `job-store.ts` and `artifact-activation.ts`.

**Complexity to remove**

- one class currently owns lifecycle, job persistence, SSE streaming, worker loop, stale-job recovery, activation, and running-process cleanup
- sync-only mode and worker-enabled mode are both implemented in the same orchestration surface
- process tracking lives as mutable state in the backend class rather than an explicit subsystem

**Implementation substeps**

1. Create `managed/context.ts`.
   - Define `ManagedRuntimeLibrariesContext` with `pool`, `blobStore`, `localCache`, `config`, `instanceId`, and shared helpers.
   - Keep this context runtime-library-specific.

2. Create `managed/process-registry.ts`.
   - Move `#runningProcesses` and `#terminateRunningProcess` out of `backend.ts`.
   - Export `registerRunningProcess(jobId, process)` and `terminateRunningProcess(jobId)` as the public API. Both `release-builder.ts` and `job-worker.ts` depend on this registry.
   - Preserve graceful SIGTERM then SIGKILL behavior and log timing.
   - Keep registry semantics explicit and synchronous.

3. Create `managed/job-store.ts`.
   - Move `#insertJob`, `#appendJobLog`, `#updateJobStatus`, `#failJob`, `#touchJob`, `#isCancellationRequested`, and `#throwIfCancellationRequested`.
   - Keep direct use of `schema.ts` query helpers and row mappers.
   - Preserve `isUniqueViolation` conflict handling.

4. Create `managed/job-stream.ts`.
   - Move `streamJob()` into its own module.
   - Keep SSE framing, keepalive, and done/error termination behavior unchanged.
   - Keep polling semantics explicit rather than inventing a generic event-stream wrapper.

5. Create `managed/job-worker.ts`.
   - Move `#startWorkerLoop`, `#workerLoop`, `#claimNextJob`, `#withJobHeartbeat`, and `#recoverStaleJobs`.
   - Keep worker-enabled vs sync-only branching in the public backend, but move the actual loop into this module.
   - Preserve stale-job failure semantics and heartbeat intervals.

6. Create `managed/artifact-activation.ts`.
   - Move the "build release -> upload artifact -> activate release -> finalize job" flow out of `#processJob`.
   - Keep use of `release-builder.ts`, `local-cache.ts`, and `state.ts` explicit.
   - Preserve rollback and delete-on-failure behavior for uploaded release artifacts.

7. Create `managed/replica-status.ts`.
   - Move `clearStaleReplicaStatuses()` and any related replica-readiness helpers.
   - Keep its data flow aligned with `runtime-library-cleanup.test.ts`.

8. Refactor `ManagedRuntimeLibrariesBackend`.
   - Keep the public facade for `initialize`, `prepareForExecution`, `dispose`, `getState`, `enqueueInstall`, `enqueueRemove`, `getJob`, `cancelJob`, `clearStaleReplicaStatuses`, and `streamJob`.
   - Keep `jobWorkerEnabled` branching at the facade level so the supported modes stay visible.
   - Preserve `globalThis.__RIVET_PREPARE_RUNTIME_LIBRARIES__` behavior and local-cache sync semantics.

9. Run an anti-complexity review before finishing the phase.
   - Reject any shared "managed backend" superclass spanning workflows and runtime libraries.
   - Keep `schema.ts`, `state.ts`, `release-builder.ts`, `cleanup.ts`, and `blob-store.ts` as domain helpers, not hidden implementation details behind a second abstraction layer.
   - Verify no circular imports exist in the new module graph. The dependency order must be: `schema.ts` → `state.ts`/`job-store.ts`/`process-registry.ts` → `job-worker.ts`/`artifact-activation.ts` → `context.ts` → `backend.ts` facade.

**Required result**

- backend init/dispose remains public and unchanged
- enqueue/get/cancel/stream behavior remains unchanged
- sync-only and worker-enabled modes remain explicit and easy to trace
- no single file mixes all of:
  - DB access
  - SSE streaming
  - worker control loop
  - process termination
  - release activation
- runtime-library code stays domain-local; do not merge it into shared workflow-managed infrastructure

**Risks**

- job cancellation and process termination are timing-sensitive and easy to regress during extraction
- the activation flow mixes object storage, DB transaction, and local-cache invalidation; splitting it can accidentally reorder side effects
- hiding `jobWorkerEnabled` behind too much structure would make the supported runtime modes less obvious
- SSE stream behavior is externally visible; even small framing changes would be a functional regression

### 3. Backend compatibility boundaries and filesystem recording-state cleanup

**Target files**

- `wrapper/api/src/routes/workflows/recordings.ts`
- `wrapper/api/src/routes/workflows/recordings-db.ts`
- `wrapper/api/src/routes/workflows/storage-backend.ts`
- `wrapper/api/src/routes/workflows/workflow-mutations.ts`
- `wrapper/api/src/routes/workflows/publication.ts`
- `wrapper/api/src/routes/workflows/execution.ts`
- `wrapper/api/src/routes/native-io.ts`

**Complexity to remove**

- `recordings.ts` still owns a large amount of hidden mutable process state
- route modules still mix HTTP translation, normalization, storage lookup, and artifact operations
- `storage-backend.ts` is the compatibility boundary, but parts of its logic are still cluttered by inline mode branching
- `native-io.ts` mixes managed virtual-path semantics with filesystem/native operations in one long file

**Implementation substeps**

1. Create `routes/workflows/recordings-store.ts`.
   - Move filesystem recording storage readiness, cleanup scheduling, persistence queue, and test reset state out of `recordings.ts`.
   - Move exactly these 8 module-scoped variables: `storageReadyPromise`, `storageReadyRoot`, `cleanupPromise`, `cleanupRequested`, `persistenceQueue`, `persistenceQueuePromise`, `lastDroppedPersistenceLogAt`, `resettingWorkflowRecordingStorageForTests`.
   - Preserve persistence queue backpressure: tasks exceeding `maxPendingWrites` are dropped with rate-limited logging. Do not convert drops to thrown errors.
   - Preserve the cleanup scheduler's "run-to-completion then reschedule if pending" recursion. Do not simplify to a single-shot timer.
   - Preserve storage readiness root-pinning: if a different root is passed, it reinitializes. This is a safeguard for test isolation.
   - Preserve the test-reset hook as an explicit `resetForTests()` method on the recordings store. Do not remove the `resettingWorkflowRecordingStorageForTests` check from production paths — the cleanup scheduler and persistence queue both check it to short-circuit during test isolation.

2. Slim `recordings.ts`.
   - Keep it focused on recording-domain operations and artifact normalization.
   - Move artifact serialization/deserialization helpers into a local helper module if they remain pure and shared.
   - Do not merge DB query code back into this file.

3. Reorganize `storage-backend.ts` by domain.
   - Group exports by hosted IO, tree/catalog operations, mutations, publication, execution resolution, and recordings.
   - Keep `filesystem` vs `managed` routing explicit at the function boundary.
   - Do not replace the compatibility boundary with a generic delegator that hides control flow.

4. Extract request/input validation helpers.
   - `workflow-mutations.ts`: name/path/body validation
   - `publication.ts`: endpoint normalization and user-facing validation
   - `execution.ts`: route/input normalization and run-kind branching
   - `native-io.ts`: managed virtual-path checks and dir-read option normalization

5. Split `native-io.ts` only where it removes real complexity.
   - Keep managed virtual-path semantics explicit.
   - If extracted, create a helper like `managed-virtual-io.ts` for the managed side only.
   - Do not hide `filesystem` vs managed virtual behavior behind opaque adapters.

6. Run an anti-complexity review before finishing the phase.
   - `storage-backend.ts` must remain a readable compatibility story.
   - Reject any change that makes it harder to see which code path runs in `filesystem` vs `managed`.

**Required result**

- route and compatibility modules stop mixing transport concerns with storage implementation details
- filesystem recording persistence no longer depends on scattered module globals
- normalization helpers live next to their domain, not inline inside route handlers
- backend-selection code remains obvious to a reader who needs to understand the compatibility story quickly

**Risks**

- filesystem recording persistence is stateful; moving queues and readiness can easily break cleanup timing
- over-abstracting `storage-backend.ts` would remove one of the most important readability seams in the codebase
- `native-io.ts` exposes managed virtual-path behavior that is subtly different from filesystem semantics; collapsing them too aggressively could introduce edge-case regressions

### 4. Frontend dashboard, modal, and client decomposition

**Target files**

- `wrapper/web/dashboard/WorkflowLibraryPanel.tsx`
- `wrapper/web/dashboard/RunRecordingsModal.tsx`
- `wrapper/web/dashboard/ProjectSettingsModal.tsx`
- `wrapper/web/dashboard/useRuntimeLibrariesModalState.ts`
- `wrapper/web/dashboard/workflowApi.ts`
- `wrapper/web/dashboard/runtimeLibrariesApi.ts`
- `wrapper/web/dashboard/DashboardPage.tsx`
- `wrapper/web/dashboard/EditorMessageBridge.tsx`
- `wrapper/web/overrides/components/NavigationBar.tsx`
- `wrapper/web/overrides/hooks/useRemoteExecutor.ts`
- `wrapper/web/overrides/hooks/useRemoteDebugger.ts`

**Complexity to remove**

- large components still combine data loading, mutation orchestration, modal state, and rendering
- runtime-library modal logic hides SSE and long-lived controller state inside one hook
- remote executor/debugger hooks still own protocol/state machines directly
- API client code duplicates response/error handling patterns

**Implementation substeps**

1. Extract `WorkflowLibraryPanel` controller logic.
   - Create `useWorkflowLibraryController.ts` for tree refresh, background reconciliation, selection, upload/download/duplicate state, and mutation orchestration.
   - Keep drag/drop state in the controller or a focused `useWorkflowLibraryDragState` helper if it reduces branching.
   - Keep presentational subcomponents thin and prop-driven.

2. Extract `RunRecordingsModal` controller logic.
   - Create `useRunRecordingsController.ts` for workflow loading, run loading, filter/page state, and delete flow.
   - Keep `RecordingRow` as a focused row component.
   - If useful, create `RecordingWorkflowSelect.tsx` and `RecordingRunsTable.tsx`.

3. Extract `ProjectSettingsModal` action logic.
   - Create `useProjectSettingsActions.ts` for rename, publish, unpublish, and delete flows.
   - Create `projectSettingsForm.ts` for endpoint/project-name validation helpers and display formatting.
   - Keep the modal component primarily presentational.

4. Slim runtime-library modal state hook.
   - Slim `useRuntimeLibrariesModalState.ts` rather than replacing it. The hook already exists as a standalone 371-line extracted hook managing SSE lifecycle, log merging, and replica tracking.
   - Extract SSE connection lifecycle and log merging into `runtimeLibrariesJobStream.ts` to reduce the hook's scope.
   - Do not create a parallel `useRuntimeLibrariesController.ts` that duplicates its role.
   - Keep `runtimeLibrariesApi.ts` flat; only extract shared request helpers, not endpoint-specific functions.

5. Extract dashboard shell state.
   - Create `useDashboardSidebar.ts` for resize/collapse/ghost state.
   - Create `useEditorBridgeEvents.ts` for window message handling and command dispatch.
   - Create `editorBridgeFocus.ts` for focus-preservation helpers.

6. Split `NavigationBar`.
   - Extract search input, go-to results, and highlight rendering into dedicated components/helpers.
   - Keep the top-level component focused on composition and atom wiring.

7. Split remote debugger and executor protocol state.
   - Extract the module-level WebSocket singleton into `remoteDebuggerClient.ts` (connection/reconnect/send lifecycle). Preserve the singleton pattern — `useRemoteDebugger.ts` is NOT a standard React hook but a thin wrapper around module-level state (`ws`, `wsUrl`, `reconnectTimer`, `sharedRemoteDebuggerState`, `remoteDebuggerSubscribers`). The single-WebSocket guarantee prevents multi-instance chaos.
   - Extract dataset message handlers into `remoteDebuggerDatasets.ts` for dataset forwarding.
   - The `useRemoteDebugger` hook becomes a thin subscriber to the module-level client.
   - Create `remoteExecutorProtocol.ts` for message dispatch and upload/run protocol.
   - Replace the loose `graphExecutionPromise` module variable with an explicit `remoteExecutionSession.ts` object that still preserves the current one-run-at-a-time limitation.
   - Keep the limitation explicit in comments and docs; do not pretend the protocol is run-scoped if it is not.

8. Extract shared API request helpers.
   - Extract only common `parseJsonResponse()`, `parseTextResponse()`, and error-extraction patterns from `workflowApi.ts` and `runtimeLibrariesApi.ts` into `apiRequest.ts`.
   - Do not attempt to generalize blob/SSE/content-disposition parsing — `workflowApi.ts` has domain-specific blob response handling (content-disposition parsing, browser download triggers) and `runtimeLibrariesApi.ts` has SSE streaming. These remain domain-specific in their respective modules.
   - Keep endpoint-specific calls flat and obvious.
   - Do not build a large generic data-client layer.

9. Run an anti-complexity review before finishing the phase.
   - Reject prop-drilling explosions created only to avoid one local hook.
   - Reject controller extraction if it only moves five lines of state without reducing branching.

**Required result**

- UI components become composition-heavy and side-effect-light
- socket lifecycle and protocol dispatch are testable without rendering large React trees
- dashboard shell code stops mixing DOM focus, iframe bridge protocol, and page layout in one file
- runtime-library modal behavior no longer hides long-lived SSE/state transitions inside one hook
- API client code uses one error/response path instead of duplicating fetch parsing

**Risks**

- moving state out of UI components can accidentally introduce prop churn and make the tree harder to follow if extraction is too fine-grained
- remote debugger/executor code is timing-sensitive; changing reconnect or dispatch ordering could cause subtle UI regressions
- the current `graphExecutionPromise` behavior is intentionally limited; refactoring it must preserve that limitation without implying new concurrency support
- dashboard focus/iframe behavior is browser-visible and easy to regress

### 5. Kubernetes and ops transparency refactor

**Target files**

- `charts/templates/backend-statefulset.yaml`
- `charts/templates/execution-deployment.yaml`
- `charts/templates/proxy-deployment.yaml`
- `charts/templates/web-deployment.yaml`
- `charts/templates/validate-values.yaml`
- `charts/templates/_helpers.tpl`
- `scripts/dev-kubernetes.mjs`
- `scripts/lib/kubernetes-launcher-config.mjs`
- `scripts/dev-docker.mjs`
- `scripts/prod-docker.mjs`

**Complexity to remove**

- backend and execution manifests duplicate long env/volume sections
- launcher scripts are aligned conceptually, but some command/env conventions are still spread across files
- chart helper extraction is currently shallow, but the shared env blocks are still repetitive

**Implementation substeps**

1. Create `_env.tpl`.
   - Extract shared API env wiring for backend and execution.
   - Extract shared auth/postgres/object-storage env blocks.
   - Keep control-plane-specific and execution-specific envs inline in their own manifests.

2. Create `_pod.tpl`.
   - Extract shared pod fragments only where they are truly identical: image pull secrets, common security context, common volume definitions, and repeated volume mounts.
   - Keep backend-specific two-container logic in `backend-statefulset.yaml`.
   - Document the intentional executor app-data mount difference in `_pod.tpl` comments: the executor container mounts app-data at `/home/rivet/.local/share/com.ironcladapp.rivet` (expects Rivet desktop app storage layout), while API containers mount at `/data/rivet-app`. Do not unify these paths.

3. Refactor backend/execution manifests to use the new helpers.
   - Preserve current values and branching exactly.
   - Keep `backend-statefulset.yaml` readable even if it remains longer than other manifests.

4. Keep `proxy` and `web` mostly explicit.
   - Only extract helpers if the resulting templates become clearer.
   - Do not force them through the same helper path as backend/execution just for symmetry.

5. Refactor launcher scripts only where it removes real duplication.
   - Keep `dev-kubernetes.mjs` as the Kubernetes orchestration script.
   - Keep `dev-docker.mjs` and `prod-docker.mjs` separate because their action sets differ meaningfully.
   - Normalize env loading, command tables, and diagnostics wording where useful.

6. Preserve validation visibility.
   - Keep `validate-values.yaml` explicit and operator-readable.
   - Do not factor its failure messages into indirect helpers.

7. Run an anti-complexity review before finishing the phase.
   - Reject any Helm helper extraction that makes it harder to understand the rendered pod shape.
   - Reject any launcher abstraction that obscures which commands actually run.

**Required result**

- chart templates reflect the real topology more clearly
- backend and execution manifests read as intentionally different workloads built from a shared base, not copy-pasted YAML
- launcher scripts describe the same contracts the chart enforces
- validation logic stays straightforward and operator-readable

**Risks**

- Helm over-templating can make a simpler manifest harder to read than the duplication it replaces
- backend and execution look similar but are not identical; excessive helper extraction can erase important differences
- launcher script dedup can reduce clarity if it hides actual command flow behind generic wrappers

### 6. Test harness consolidation and extracted-module coverage

**Target files**

- `wrapper/api/src/tests/workflow-services.test.ts`
- `wrapper/api/src/tests/runtime-library-cleanup.test.ts`
- `wrapper/api/src/tests/latest-workflow-remote-debugger.test.ts`
- `wrapper/api/src/tests/managed-execution-service.test.ts`
- `wrapper/api/src/tests/managed-execution-invalidation.test.ts`

**Add**

- `wrapper/api/src/tests/helpers/workflow-fixtures.ts`
- `wrapper/api/src/tests/helpers/managed-backend-harness.ts`
- `wrapper/api/src/tests/helpers/runtime-library-harness.ts`
- `wrapper/api/src/tests/helpers/http-server-harness.ts`
- `wrapper/api/src/tests/helpers/websocket-harness.ts`

**Complexity to remove**

- large integration tests spend too much space on fixture and server setup
- extracted backend helpers would otherwise be covered only indirectly
- debugger/runtime-library test setup is repeated across files

**Implementation substeps**

1. Extract workflow-managed test fixtures.
   - Move common temp-dir setup, managed env setup, and project/revision fixture creation into `workflow-fixtures.ts`.
   - Keep scenario assertions in the test files.

2. Extract backend/runtime-library harnesses.
   - Create helpers for managed backend setup and teardown.
   - Extract `FakeListener` into `managed-backend-harness.ts` with the `DeferredConnectListener` variant. These are currently duplicated across `managed-execution-service.test.ts` and `managed-execution-invalidation.test.ts`.
   - Extract `createDeferred()` into a shared test utility — identically duplicated in both execution test files.
   - Create helpers for runtime-library job and cleanup setup.
   - Keep helper APIs narrow and scenario-oriented.

3. Extract HTTP/WebSocket harnesses.
   - Reuse real server creation, websocket client setup, and cleanup logic.
   - Preserve current debugger test behavior and trust-header setup.

4. Add direct tests for newly extracted pure helpers where it reduces risk.
   - row mappers
   - endpoint sync normalization helpers
   - request/response parsing helpers
   - execution session bookkeeping helpers

5. Keep frontend verification on the current testing stack.
   - Do not add Vitest/Jest/RTL in this refactor.
   - Use Playwright for browser-visible regressions and lightweight pure-module tests only where they can run in the existing environment.

6. Update the `test` script in `wrapper/api/package.json` to include new test files for extracted helpers. The current script explicitly lists 18 test files by path — new tests must be added to this list.

7. Run an anti-complexity review before finishing the phase.
   - Reject harnesses that are more complicated than the duplicated setup they replace.
   - Keep test helpers focused on setup, not hidden assertions.

**Required result**

- biggest test files become readable scenario lists instead of setup-heavy integration scripts
- local fixtures and harnesses mirror the new internal boundaries
- websocket and managed-mode setup logic is defined once
- high-risk extracted backend helpers gain direct coverage instead of relying only on broad integration tests

**Risks**

- overly smart test harnesses can hide the scenario under test and make failures harder to understand
- table-driven conversions can reduce readability if the scenarios are only superficially similar
- adding too many helper layers to tests can reproduce the same complexity problem seen in production code

### 7. Documentation and architecture map refresh

**Target files**

- `README.md`
- `docs/architecture.md`
- `docs/development.md`
- `docs/kubernetes.md`
- `docs/access-and-routing.md`

**Complexity to remove**

- current docs explain the architecture, but they do not yet describe the intended post-refactor ownership boundaries
- without an explicit internal map, future work can drift back into god files

**Implementation substeps**

1. Add an internal architecture map to `docs/architecture.md`.
   - explain control plane
   - explain execution plane
   - explain runtime-library management plane
   - explain filesystem compatibility layer

2. Update `docs/development.md`.
   - explain where new controller/helper modules live
   - explain the "facade plus explicit context" pattern for backend modules
   - explain that compatibility boundaries must remain visible

3. Update `docs/kubernetes.md` and `docs/access-and-routing.md`.
   - keep the current Kubernetes topology explicit
   - describe backend singleton vs execution scaling
   - describe why the refactor does not change those constraints

4. Update `README.md`.
   - add a concise architecture summary
   - point contributors to the deeper architecture docs

5. Run an anti-complexity review before finishing the phase.
   - docs should reduce ambiguity, not duplicate every implementation detail.

**Required result**

- docs explain the real architecture as it exists after the refactor
- contributors can see where to put new code without recreating mixed-responsibility files
- Kubernetes guidance stays aligned with the supported topology

**Risks**

- over-documenting implementation detail can make docs noisy and stale quickly
- under-documenting the new boundaries would waste much of the refactor benefit by allowing the old complexity to return

## Execution Order

### Phase 1: Backend core consolidation

- Workstream 1
- Workstream 2

### Phase 2: Backend compatibility-boundary cleanup

- Workstream 3

### Phase 3: Frontend orchestration and client cleanup

- Workstream 4

### Phase 4: Kubernetes and launcher cleanup

- Workstream 5

### Phase 5: Test harness consolidation

- Workstream 6

### Phase 6: Docs and final transparency pass

- Workstream 7

Delivery rule:

- each phase lands green before the next phase begins
- frontend-affecting phases must include Playwright verification before phase completion
- chart/script changes must include Kubernetes verification before phase completion
- file budgets are guardrails, not permission to add indirection just to hit a number

## Test Cases And Scenarios

### Backend verification

Run after each backend phase:

```bash
npm --prefix wrapper/api run build
npm --prefix wrapper/api test
```

Required scenarios to stay green:

- filesystem workflow CRUD, publish/unpublish, open/save, duplicate/upload, and recordings behavior remain unchanged
- managed workflow CRUD, publish/unpublish, open/save, rename/move, recordings import/read/delete, and execution resolution remain unchanged
- runtime-library install/remove/stream/cancel/recovery behavior remains unchanged
- latest debugger behavior remains unchanged
- managed execution invalidation/retry behavior remains unchanged

### Frontend verification

Run after each UI-affecting phase:

```bash
PLAYWRIGHT_HEADLESS=1 PLAYWRIGHT_SLOW_MO=0 node scripts/playwright-observe.mjs test
```

Required scenarios:

- workflow library tree loading, selection, drag/drop, upload, duplicate, download, settings modal, and run recordings modal still work
- runtime-library modal install/remove/cancel/cleanup flows still work
- dashboard sidebar resizing/collapse/restore still works
- editor bridge open/save/delete/path-move behavior still works
- remote execution and remote debugger flows still work
- navigation search and go-to behavior still works

### Kubernetes and ops verification

Run after chart/launcher phases:

```bash
npm run verify:kubernetes
npm run dev:kubernetes-test:config
```

If local credentials are available, also run:

```bash
npm run dev:kubernetes-test:up
npm run dev:kubernetes-test:ps
npm run dev:kubernetes-test:down
```

Required scenarios:

- chart still enforces managed-only Kubernetes mode
- chart still enforces singleton backend
- local Kubernetes rehearsal still starts the supported topology
- proxy/backend/execution routing contracts remain unchanged
- launcher output still tells the operator the correct topology and URLs

## Explicit Assumptions And Defaults

- Use the aggressive-consolidation bias chosen here, but still land the work in phased, reviewable slices.
- Preserve all current product behavior and external contracts.
- Preserve both `filesystem` and `managed` modes.
- Treat `managed` mode as the primary production architecture and `filesystem` as compatibility/migration/local fallback.
- Keep Kubernetes managed-only, `backend=1`, `execution` as the main scale target, `proxy` independently scalable, and `web=1` by default.
- Do not introduce inheritance-heavy abstractions or generic helper factories unless they represent a real ownership boundary.
- Prefer composition plus explicit context objects over module-scoped mutable state and lambda wiring.
- Do not create a shared workflow/runtime-library "managed backend framework" in this refactor; keep common infrastructure domain-local unless duplication remains obviously harmful after the domain-local split.
- Workflow blob store uses text serialization (`putText`/`getText` for project YAML, dataset JSON, recording data). Runtime-library blob store uses binary serialization (`putBuffer`/`getBuffer` for tar archives). These are intentionally separate interfaces. Do not unify them.
- Any UI-affecting refactor must update relevant docs and pass Playwright.
- Any Kubernetes-affecting refactor must update docs and pass chart/launcher verification.

## Codebase Audit: Gaps Found and Corrections

This section documents gaps discovered by deep code analysis, compared against every workstream's assumptions. Each gap is tagged to its workstream so the fix can land in the right phase.

### Gap 1 (Workstream 1): Initialization and disposal ordering is undocumented but correctness-critical

The current `ManagedWorkflowBackend.initialize()` has this exact sequence:

1. `blobStore.initialize()` (S3 bucket check/create)
2. `pool.query(MANAGED_WORKFLOW_SCHEMA_SQL)` (DB schema init, wrapped in `withManagedDbRetry`)
3. `executionInvalidationController.initialize()` (starts PG LISTEN, begins notification processing)

Disposal is:

1. `this.#disposed = true`
2. `executionInvalidationController.dispose()` (stops PG LISTEN, cancels reconnect timer)
3. `executionCache.clearRevisionMaterializations()`
4. `pool.end()`

**Fix:** `managed/context.ts` must document and enforce this exact order. The context's `initialize()` and `dispose()` must be the single owner of sequencing — not something each consumer re-discovers. Add inline comments in the context with the ordering rationale.

### Gap 2 (Workstream 1): Bidirectional dependency between execution infrastructure modules

The backend currently creates callbacks that wire execution cache invalidation into the execution invalidation controller:

```
ExecutionService → depends on → ExecutionInvalidationController
ExecutionInvalidationController → calls back into → ExecutionCache
```

This means `ManagedWorkflowContext` cannot just hold these as flat peers — the invalidation controller must receive cache callbacks at construction time, and the execution service must receive the controller. The context must compose them in the right order.

**Fix:** Add a substep to Workstream 1 step 7 specifying the wiring order:
1. Create `executionCache`
2. Create `executionInvalidationController` with cache callbacks
3. Create `executionService` with both cache and controller

### Gap 3 (Workstream 1): `types.ts` already exists and holds shared types

The managed workflow directory already has `types.ts` containing `TransactionHooks`, `WorkflowRow`, `RecordingRow`, and other shared type definitions. The plan proposes creating `managed/mappers.ts` and `managed/transactions.ts` — these should import from the existing `types.ts` rather than redefining types.

**Fix:** Add `managed/types.ts` to the "existing files to preserve" list. Ensure `mappers.ts` and `transactions.ts` import `TransactionHooks`, `WorkflowRow`, etc. from `types.ts` rather than re-exporting or duplicating them.

### Gap 4 (Workstream 1): `withManagedDbRetry` is a contract, not just a helper

The `withManagedDbRetry` function is not only used by backend.ts — it is also injected into the `ManagedWorkflowExecutionInvalidationController` constructor as a dependency. This makes it a correctness-critical contract between infrastructure modules, not just a convenience wrapper.

**Fix:** When extracting `managed/db.ts`, document that `withManagedDbRetry` is a public contract consumed by the invalidation controller. Its retry codes (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`) and attempt count (3) are part of this contract.

### Gap 5 (Workstream 2): `cleanup.ts` (491 lines) is not mentioned anywhere in the plan

The runtime-libraries managed directory contains `cleanup.ts` with audit/retention/prune logic including:
- `auditManagedRuntimeLibrariesState()` — complete state analysis
- `pruneManagedRuntimeLibrariesState()` — retention policy enforcement
- Retention policy constants (7-day releases, 24h orphaned artifacts, 30d succeeded jobs, 14d failed jobs)

This file already exists alongside `blob-store.ts` (239 lines, also not mentioned), and both are well-structured, domain-local helpers.

**Fix:** Add both `cleanup.ts` and `blob-store.ts` to the Workstream 2 target files list as "existing files to preserve." Add a substep noting: "Keep `cleanup.ts` and `blob-store.ts` as domain helpers. Do not merge them into extracted modules. The audit/prune pipeline in `cleanup.ts` spans releases, jobs, and artifacts — it should remain a separate orchestrator, not get split across `job-store.ts` and `artifact-activation.ts`."

### Gap 6 (Workstream 2): `release-builder.ts` has a process-registry dependency the plan doesn't call out

`buildReleaseArtifact()` calls `registerRunningProcess(jobId, process)` and `terminateRunningProcess()` — functions that currently live in `backend.ts`. The proposed `process-registry.ts` module must export these as callable APIs that `release-builder.ts` and `job-worker.ts` both consume.

**Fix:** Add to Workstream 2 step 2 (process-registry.ts): "Export `registerRunningProcess(jobId, process)` and `terminateRunningProcess(jobId)` as the public API. `release-builder.ts` and `job-worker.ts` both depend on this registry."

### Gap 7 (Workstream 2): Blob store interfaces intentionally diverge (text vs binary)

Two separate blob store implementations exist:
- `wrapper/api/src/routes/workflows/managed/blob-store.ts` — `putText()`/`getText()` for YAML/JSON project data
- `wrapper/api/src/runtime-libraries/managed/blob-store.ts` — `putBuffer()`/`getBuffer()` for binary tar artifacts

The plan states "do not create a shared workflow/runtime-library managed backend framework" — but doesn't explain *why* the stores differ. Without this context, a future contributor might try to unify them.

**Fix:** Add to the "Explicit Assumptions and Defaults" section: "Workflow blob store uses text serialization (project YAML, dataset JSON, recording data). Runtime-library blob store uses binary serialization (tar archives). These are intentionally separate interfaces. Do not unify them."

### Gap 8 (Workstream 3): `recordings.ts` test reset hook is production-coupled

The `resettingWorkflowRecordingStorageForTests` flag (line 155) is read in production code paths (cleanup scheduling, persistence queue). When extracting `recordings-store.ts`, this flag must remain an explicit parameter or callback on the store — not hidden behind a generic reset method.

**Fix:** Add to Workstream 3 step 1: "Preserve the test-reset hook as an explicit `resetForTests()` method on the recordings store. Do not remove the flag from production paths — the cleanup scheduler and persistence queue both check it to short-circuit during test isolation."

### Gap 9 (Workstream 3): Persistence queue has backpressure semantics

The recording persistence queue (recordings.ts) drops tasks and logs rate-limited warnings when `maxPendingWrites` is reached. The new `recordings-store.ts` must preserve these drop semantics, not convert them to errors or silent failures.

**Fix:** Add to Workstream 3 step 1: "Preserve persistence queue backpressure: tasks exceeding `maxPendingWrites` are dropped with rate-limited logging. Do not convert drops to thrown errors."

### Gap 10 (Workstream 4): `useRuntimeLibrariesModalState.ts` already exists as an extracted hook

The plan proposes "Replace or slim `useRuntimeLibrariesModalState.ts` with `useRuntimeLibrariesController.ts`" — but `useRuntimeLibrariesModalState.ts` is already a standalone 371-line hook, not embedded in a component. It manages SSE streaming, log aggregation, and replica tracking.

**Fix:** Reframe Workstream 4 step 4: "Slim `useRuntimeLibrariesModalState.ts` rather than replacing it. The hook already exists and manages SSE lifecycle, log merging, and replica tracking. Extract SSE connection lifecycle and log merging into `runtimeLibrariesJobStream.ts` to reduce the hook's scope, but do not create a parallel `useRuntimeLibrariesController.ts` that duplicates its role."

### Gap 11 (Workstream 4): `useRemoteDebugger.ts` is a module-level singleton, not a React hook

The current implementation maintains a module-level WebSocket singleton with subscriber pattern:
- Module-scoped: `ws`, `wsUrl`, `reconnectTimer`, `sharedRemoteDebuggerState`, `remoteDebuggerSubscribers`
- Functions: `doConnect`, `doDisconnect`, `doSend`, `doSendRaw`, `isExecutorConnected`
- The React hook is a thin wrapper that subscribes to the module-level state

The plan proposes splitting into `remoteDebuggerClient.ts` + `remoteDebuggerDatasets.ts`, assuming a standard hook pattern. Splitting the singleton requires preserving the single-WebSocket guarantee.

**Fix:** Reframe Workstream 4 step 7: "Extract the module-level WebSocket singleton into `remoteDebuggerClient.ts` (connection/reconnect/send lifecycle). Keep the singleton pattern — the single-WebSocket guarantee prevents multi-instance chaos. Extract dataset message handlers into `remoteDebuggerDatasets.ts`. The `useRemoteDebugger` hook becomes a thin subscriber to the module-level client."

### Gap 12 (Workstream 4): API layer generalization is harder than assumed

`workflowApi.ts` (332 lines, 20+ functions) uses domain-specific response parsing: blob responses with content-disposition parsing, text responses, JSON responses with custom error extraction. `runtimeLibrariesApi.ts` (118 lines, 6 functions) uses a different pattern with SSE streaming.

**Fix:** Narrow the scope of `apiRequest.ts`: "Extract only the common `parseJsonResponse()`, `parseTextResponse()`, and error-extraction patterns. Do not attempt to generalize blob/SSE/content-disposition parsing — these remain domain-specific in their respective API modules."

### Gap 13 (Workstream 5): Volume mount inconsistency between executor and API containers

The executor container mounts app-data at `/home/rivet/.local/share/com.ironcladapp.rivet` while all API containers mount it at `/data/rivet-app`. This is intentional (the executor expects a different storage layout) but is not documented.

**Fix:** Add to Workstream 5 step 2: "Document the intentional executor app-data mount difference in `_pod.tpl` comments. The executor uses `/home/rivet/.local/share/com.ironcladapp.rivet` because it expects the Rivet desktop app storage layout. Do not unify this with the API mount path."

### Gap 14 (Workstream 6): `package.json` test script must be updated

The test script in `wrapper/api/package.json` explicitly lists 18 test files by path. Adding tests for newly extracted modules (mappers, endpoint-sync, revision-factory helpers) requires updating this list.

**Fix:** Add to Workstream 6: "Update the `test` script in `wrapper/api/package.json` to include new test files for extracted helpers. Verify the complete test list matches the actual test directory contents."

### Gap 15 (Workstream 6): `FakeListener` and `createDeferred` are duplicated across test files

`FakeListener` is defined separately in both `managed-execution-service.test.ts` and `managed-execution-invalidation.test.ts` (with slight variations). `createDeferred()` is identically duplicated in both files.

**Fix:** Add to Workstream 6 step 2: "Extract `FakeListener` into `managed-backend-harness.ts` with the `DeferredConnectListener` variant. Extract `createDeferred()` into a shared test utility. Both are currently duplicated across execution test files."

### Gap 16 (Cross-cutting): No import-graph safety verification

The refactor creates many new modules that import from each other. There is no step verifying that the new module boundaries don't introduce circular imports.

**Fix:** Add to each workstream's anti-complexity review: "Verify no circular imports exist in the new module graph. The dependency order must be: `types.ts` → `mappers.ts`/`db.ts` → `transactions.ts` → domain services → `context.ts` → `backend.ts` facade. If TypeScript reports circular references, reject the module boundary and restructure."

### Gap 17 (Cross-cutting): Transaction hook ordering is correctness-sensitive across all domain services

The `TransactionHooks` pattern (`onCommit`/`onRollback`) is used by catalog, revisions, publication, and recordings. The commit tasks run AFTER the database COMMIT, and rollback tasks run AFTER ROLLBACK. Reordering these (e.g., running cleanup before commit) would silently corrupt data.

**Fix:** Add to Workstream 1 step 3 (transactions.ts): "Document the execution order contract: `onRollback` tasks run if the transaction fails, `onCommit` tasks run after successful COMMIT. Blob cleanup is scheduled via `onRollback` to prevent orphaned objects. Execution invalidation is scheduled via `onCommit` to prevent premature cache updates. This ordering is correctness-critical."
