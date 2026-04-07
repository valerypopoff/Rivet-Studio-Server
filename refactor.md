# Post-Kubernetizing Refactoring Plan

## Goal

Reduce code size and complexity without changing functionality. Every change here is a pure refactor: same behavior, less code, clearer structure.

## Priority Legend

- `P0` — high duplication or complexity, large line savings, low risk
- `P1` — moderate savings, moderate risk
- `P2` — small savings or cosmetic, do when touching nearby code

---

## 1. Backend: The Managed Workflow Backend Monster

**File:** `wrapper/api/src/routes/workflows/managed/backend.ts` (2,279 lines)

This is the single largest file in the codebase. It mixes SQL schema, query helpers, CRUD operations, publication logic, recording persistence, and blob management into one class.

### 1.1 Extract SQL column constants `P0`

The same workflow column list appears in 4 places (verified):
- `#listWorkflowRows()` (lines ~732-733)
- `#getWorkflowByRelativePath()` (lines ~743-744)
- `#getWorkflowById()` (lines ~757-758)
- `listWorkflowRecordingWorkflows()` (lines ~2032-2033, adds `w.` table prefix but same columns)

All 4 select the identical 11 columns: `workflow_id, name, file_name, relative_path, folder_relative_path, updated_at, current_draft_revision_id, published_revision_id, endpoint_name, published_endpoint_name, last_published_at`.

The same recording column list appears in 4 places (verified):
- `deleteWorkflowRecording()` (lines ~1862-1865)
- `listWorkflowRecordingRunsPage()` (lines ~2102-2105)
- `readWorkflowRecordingArtifact()` (lines ~2147-2150)
- A second query inside `deleteWorkflowRecording()` (lines ~2176-2179)

All 4 select the identical 20 columns: `recording_id, workflow_id, source_project_name, source_project_relative_path, created_at, run_kind, status, duration_ms, endpoint_name_at_execution, error_message, recording_blob_key, replay_project_blob_key, replay_dataset_blob_key, has_replay_dataset, recording_compressed_bytes, recording_uncompressed_bytes, project_compressed_bytes, project_uncompressed_bytes, dataset_compressed_bytes, dataset_uncompressed_bytes`.

**Where:** Top of `managed/backend.ts`, before the class definition.

**What to change:**
```ts
const WORKFLOW_COLUMNS = `workflow_id, name, file_name, relative_path, folder_relative_path, updated_at,
  current_draft_revision_id, published_revision_id, endpoint_name, published_endpoint_name, last_published_at`;

const RECORDING_COLUMNS = `recording_id, workflow_id, source_project_name, source_project_relative_path, created_at,
  run_kind, status, duration_ms, endpoint_name_at_execution, error_message,
  recording_blob_key, replay_project_blob_key, replay_dataset_blob_key, has_replay_dataset,
  recording_compressed_bytes, recording_uncompressed_bytes, project_compressed_bytes,
  project_uncompressed_bytes, dataset_compressed_bytes, dataset_uncompressed_bytes`;
```

Replace each inline column list with `${WORKFLOW_COLUMNS}` or `${RECORDING_COLUMNS}`. The `listWorkflowRecordingWorkflows` occurrence needs the `w.` table-qualified variant — use a small helper `withTablePrefix(cols, 'w')` or define a second constant `WORKFLOW_COLUMNS_QUALIFIED`.

**How to verify:** Run existing tests (`npm test` in `wrapper/api`). SQL output is identical. No runtime change.

**Estimated savings:** ~60 lines (corrected from original ~80 — 4 occurrences each, not 5+)

**Risks:**
- If any occurrence has a subtly different column order or an extra column, the query will silently return wrong data. Mitigate by verifying each replacement with a diff of the generated SQL.
- The `w.`-prefixed variant in `listWorkflowRecordingWorkflows` requires care — it joins with other tables so the qualified constant must use `w.` prefix consistently.

### 1.2 Extract recording blob upload and insert helpers `P0`

`importWorkflowRecording()` (lines ~1952-2025) and `persistWorkflowExecutionRecording()` (lines ~2198-2278) both:
1. Build 3 blob keys (recording, replay-project, optional replay-dataset)
2. Upload blobs in parallel with `Promise.all`
3. On upload failure, delete partial uploads with `#deleteBlobKeysBestEffort`
4. Insert a recording row with a 20-column INSERT statement

Verified differences:
- **Blob upload**: Structurally identical. Different variable names (`options.recordingContents` vs `options.recordingSerialized`) but same shape — 3 `putText` calls with identical conditional logic for the optional dataset blob.
- **INSERT SQL**: Column list is identical. VALUES differ only in timestamp: `$5::timestamptz` (import passes a timestamp) vs `NOW()` (persist uses server time). The `ON CONFLICT (recording_id) DO NOTHING` clause is only on the import version.
- **Row data preparation**: Fundamentally different — import reads from `options` directly, persist derives values from Project objects and serialization results.

**Where:** New private methods on `ManagedWorkflowBackend` or module-level helpers in `managed/backend.ts`.

**What to change:**

Extract a blob upload helper:
```ts
async #uploadRecordingBlobs(
  recordingId: string,
  artifacts: { recording: string; replayProject: string; replayDataset?: string | null },
): Promise<{ recordingBlobKey: string; replayProjectBlobKey: string; replayDatasetBlobKey: string | null }> {
  // Build keys, upload in parallel, cleanup on failure
}
```

Extract a row insert helper that takes a timestamp parameter:
```ts
async #insertRecordingRow(
  client: PoolClient,
  row: RecordingRowData,
  timestampMode: 'provided' | 'now',
  onConflict: 'ignore' | 'fail',
): Promise<void> {
  // Single INSERT with parameterized timestamp handling
}
```

Both callers shrink to: prepare row data → call `#uploadRecordingBlobs` → call `#insertRecordingRow`.

**How to verify:** Run recording-related tests. Import and persist paths both exercise these. Managed-mode Playwright flow covers end-to-end recording persistence.

**Estimated savings:** ~50 lines (corrected from ~60 — row data preparation stays in each caller)

**Risks:**
- The `ON CONFLICT DO NOTHING` clause only exists on the import path. The extracted helper must parameterize this, not assume one behavior.
- The timestamp difference (`$5::timestamptz` vs `NOW()`) is subtle. A parameter like `timestampMode` must be clearly documented.
- Blob key construction logic may have subtle differences between import and persist paths — verify key prefix patterns match.

### 1.3 Split the class into focused modules `P1`

The `ManagedWorkflowBackend` class has 20+ methods spanning unrelated concerns.

**Where:** `wrapper/api/src/routes/workflows/managed/` directory.

**What to change:** Create new modules and move methods:

- `managed/schema.ts` — the `SCHEMA_SQL` constant and `#ensureSchema()` method (~200 lines of SQL DDL at lines ~215-417)
- `managed/catalog.ts` — folder/workflow CRUD methods: `getTree`, `createWorkflowFolderItem`, `renameWorkflowFolderItem`, `deleteWorkflowFolderItem`, `#moveFolderRelativePath`, `createWorkflowProjectItem`, `renameWorkflowProjectItem`, `deleteWorkflowProjectItem`, `listProjectPathsForHostedIo`, `moveWorkflowProject`, `moveWorkflowFolder` (~500 lines)
- `managed/revisions.ts` — `saveHostedProject`, `importWorkflow`, `#readRevisionContents`, revision blob upload/cleanup helpers (~350 lines)
- `managed/publication.ts` — `publishWorkflowProjectItem`, `unpublishWorkflowProjectItem`, endpoint resolution queries (~250 lines)
- `managed/recordings.ts` — recording import, persist, list, delete, replay lookup, the extracted blob/insert helpers from 1.2 (~400 lines)
- `managed/backend.ts` — thin facade that instantiates the above modules with shared `Pool` and `BlobStore` dependencies, exposes the combined backend interface

Each module receives the database pool and blob store as constructor or function parameters. The facade wires them together and re-exports the unified interface that `storage-backend.ts` consumes.

**How to verify:** All existing tests pass. The public interface of `ManagedWorkflowBackend` does not change — only its internal organization.

**Estimated savings:** No net line reduction. Each file drops to 200-500 lines instead of one 2,279-line monster.

**Risks:**
- Private methods (`#deleteBlobKeysBestEffort`, `#queryRows`, `#queryOne`, transaction helpers) are shared across all concerns. These must become shared utilities within the `managed/` directory, which changes the class's encapsulation model.
- The transaction hook pattern (`hooks.onCommit`/`hooks.onRollback`) is used across multiple concern areas. It must remain accessible to all split modules.
- This is the highest-risk refactor in the plan. Do it last among the backend items, after 1.1 and 1.2 are stable.

### 1.4 Deduplicate revision blob rollback pattern `P2`

Three places schedule blob deletion on transaction rollback (verified):
- `saveHostedProject()` (line ~1189)
- `importWorkflow()` (line ~1280) — draft revision
- `importWorkflow()` (line ~1298) — published revision

All three are structurally identical: `hooks.onRollback(() => this.#deleteBlobKeysBestEffort('transaction rollback', [revision.project_blob_key, revision.dataset_blob_key]))`. The only difference is the variable name (`revision`, `draftRevision`, `publishedRevision!`).

**Where:** New private method on `ManagedWorkflowBackend`.

**What to change:**
```ts
#scheduleRevisionBlobCleanup(hooks: TransactionHooks, revision: { project_blob_key: string; dataset_blob_key: string | null }): void {
  hooks.onRollback(() => this.#deleteBlobKeysBestEffort('transaction rollback', [
    revision.project_blob_key,
    revision.dataset_blob_key,
  ]));
}
```

Each call site becomes a one-liner.

**How to verify:** Run workflow save and import tests. Verify rollback behavior by checking that blob cleanup is still triggered on transaction failure.

**Estimated savings:** ~10 lines

**Risks:**
- Minimal. The helper is a trivial wrapper. The only concern is ensuring the `revision` parameter type matches all three call sites (the `publishedRevision!` non-null assertion must be handled before calling the helper).

### 1.5 Deduplicate recording error cleanup pattern `P0` *(NEW — gap in original plan)*

4 places call `#deleteBlobKeysBestEffort` for recording failure cleanup (verified):
- `importWorkflowRecording()` upload failure (line ~1981)
- `importWorkflowRecording()` insert failure (line ~2022)
- `persistWorkflowExecutionRecording()` upload failure (line ~2236)
- `persistWorkflowExecutionRecording()` insert failure (line ~2275)

All follow the pattern: `await this.#deleteBlobKeysBestEffort('recording <context> failure', uploadedBlobKeys)`.

**Where:** This is addressed by item 1.2 — when the upload and insert logic is extracted into helpers, the error cleanup becomes internal to those helpers. No separate extraction needed if 1.2 is done first.

**Estimated savings:** Included in 1.2's savings.

**Risks:** Same as 1.2.

---

## 2. Backend: Storage Backend Delegation

**File:** `wrapper/api/src/routes/workflows/storage-backend.ts` (423 lines)

### 2.1 Replace repetitive wrappers with a generic delegator `P0`

Verified: 23 exported functions follow the delegation pattern (not 35+ as originally claimed). Additionally, 3 functions are managed-only (no filesystem fallback) and 2 functions have non-trivial differences between paths.

The 23 uniform delegation functions each check `isManagedWorkflowStorageEnabled()`, get the managed backend, and call the corresponding method. The filesystem fallback typically calls a local function with the workflows root path.

Functions that **cannot** use a simple delegator:
- `resolvePublishedExecutionProject()` (lines ~348-367): The filesystem path has complex multi-step logic (find workflow → load project → build dataset provider → assemble return). The managed path is a single backend call. These are architecturally different, not just calling different functions.
- `resolveLatestExecutionProject()` (lines ~369-388): Same issue as above.
- `persistWorkflowExecutionRecordingWithBackend()` (lines ~399-419): The filesystem path destructures `{ root, ...options }` and passes `root` separately. Different call shape.
- `readManagedHostedText()`, `managedHostedPathExists()`, `readManagedHostedRelativeProject()`: Managed-only, no filesystem fallback.

**Where:** Top of `storage-backend.ts`, before the exported functions.

**What to change:**
```ts
async function delegate<T>(
  managedFn: (backend: ManagedWorkflowBackend) => Promise<T>,
  fsFn: () => Promise<T>,
): Promise<T> {
  if (isManagedWorkflowStorageEnabled()) {
    const backend = await getManagedBackend();
    return managedFn(backend);
  }
  return fsFn();
}
```

Apply to the ~18 functions that are truly uniform (both paths have matching call shapes). Keep the 5 non-uniform functions as-is with inline if/else — do not force them into the delegator pattern.

**How to verify:** All existing tests pass. Each refactored function produces identical behavior for both storage modes.

**Estimated savings:** ~80 lines (corrected from ~150 — only ~18 of the 23 functions are uniform enough, and each saves ~4-5 lines)

**Risks:**
- TypeScript generics may require explicit type annotations at some call sites to preserve return type inference. Test that callers still get the correct types.
- The 5 non-uniform functions must NOT be forced into the delegator. Doing so would obscure their architectural differences and make the code harder to understand.

---

## 3. Backend: Recordings DB

**Files:**
- `wrapper/api/src/routes/workflows/recordings.ts` (989 lines)
- `wrapper/api/src/routes/workflows/recordings-db.ts` (535 lines)

### 3.1 Deduplicate SQL column lists in recordings-db.ts `P0`

Verified: The full `recording_runs` SELECT column list (17 columns with aliases) appears in **6** separate query functions (corrected from 5):
- `listWorkflowRecordingRunRowsByWorkflowId()` (lines ~284-301)
- `getWorkflowRecordingRunRow()` (lines ~328-345)
- `listWorkflowRecordingRunRowsForWorkflow()` (lines ~356-373)
- `listWorkflowRecordingRunsOlderThan()` (lines ~385-402)
- `listWorkflowRecordingRunsOldestFirst()` (lines ~414-431)
- Note: `listWorkflowRecordingWorkflowStatsRows()` uses a DIFFERENT column list with aggregates — do not consolidate with this one.

All 6 are 100% identical: same 17 columns, same order, same aliases.

**Where:** Top of `recordings-db.ts`, as a module-level constant.

**What to change:**
```ts
const RECORDING_RUN_COLUMNS = `
  id AS id,
  workflow_id AS workflowId,
  created_at AS createdAt,
  run_kind AS runKind,
  status AS status,
  duration_ms AS durationMs,
  endpoint_name_at_execution AS endpointNameAtExecution,
  error_message AS errorMessage,
  bundle_path AS bundlePath,
  encoding AS encoding,
  has_replay_dataset AS hasReplayDataset,
  recording_compressed_bytes AS recordingCompressedBytes,
  recording_uncompressed_bytes AS recordingUncompressedBytes,
  project_compressed_bytes AS projectCompressedBytes,
  project_uncompressed_bytes AS projectUncompressedBytes,
  dataset_compressed_bytes AS datasetCompressedBytes,
  dataset_uncompressed_bytes AS datasetUncompressedBytes`;
```

Replace 6 inline column lists with `${RECORDING_RUN_COLUMNS}`.

**How to verify:** Run `recordings-db` tests and the full workflow-services test suite.

**Estimated savings:** ~85 lines (corrected up from ~60 — 6 occurrences × ~15 lines each, minus the constant definition)

**Risks:**
- Minimal. Pure string replacement. The constant is used only in template literals that build SELECT statements.
- Verify the `listWorkflowRecordingWorkflowStatsRows` function is NOT touched — it has a fundamentally different column list with aggregates.

### 3.2 Extract shared WHERE clause builder `P2`

Status filter WHERE clause construction is duplicated in 2 functions.

**Where:** `recordings-db.ts`, new helper function.

**What to change:**
```ts
function buildRunFilterClause(statusFilter: string | undefined): { where: string; params: any[] } {
  if (statusFilter === 'failed') {
    return { where: `WHERE workflow_id = ? AND status IN ('failed', 'suspicious')`, params: [] };
  }
  return { where: 'WHERE workflow_id = ?', params: [] };
}
```

**How to verify:** Run recordings-db tests.

**Estimated savings:** ~8 lines

**Risks:**
- Minimal. Two call sites with identical logic.

### 3.3 Simplify normalizeStoredWorkflowRecording `P1`

**Where:** `recordings.ts`, the `normalizeStoredWorkflowRecording()` function (lines ~242-372).

**What to change:** Extract the shared validation that both v1 and v2 branches perform into a `validateRecordingFields(obj)` helper. Both branches currently validate the same required fields (workflowId, recording id, status, timestamps) with identical logic. Each branch then becomes ~15 lines of version-specific field extraction plus the shared validation call.

**How to verify:** Run recording normalization tests and the full workflow-services test suite. Edge cases: malformed v1 recordings, malformed v2 recordings, missing fields.

**Estimated savings:** ~40 lines

**Risks:**
- The v1 and v2 branches may have subtle validation differences that are easy to miss when extracting. Carefully diff both branches line-by-line before extracting.
- Some v1 fields have different names or shapes than v2. The shared validator must only cover truly common fields.

### 3.4 Consolidate artifact encoding helpers `P2`

`readArtifactBytes` and `readArtifactText` both read a file, check encoding, optionally decompress.

**Where:** `recordings.ts`.

**What to change:**
```ts
async function readArtifactRaw(filePath: string, encoding: WorkflowRecordingBlobEncoding): Promise<Buffer> {
  const raw = await fs.readFile(filePath);
  return encoding === 'gzip' ? await gunzipAsync(raw) : raw;
}
```
`readArtifactBytes` becomes `return readArtifactRaw(path, enc)`.
`readArtifactText` becomes `return (await readArtifactRaw(path, enc)).toString('utf-8')`.

**How to verify:** Run recording artifact read tests.

**Estimated savings:** ~12 lines

**Risks:**
- Minimal. Both functions already handle the same two encoding cases (`identity` and `gzip`).

---

## 4. Backend: Workflow Mutations

**File:** `wrapper/api/src/routes/workflows/workflow-mutations.ts` (485 lines)

### 4.1 Unify duplicate and upload retry loops `P0`

Verified: The retry loops in `duplicateWorkflowProjectItem()` (lines ~292-330) and `uploadWorkflowProjectItem()` (lines ~359-395) are 97% identical. The differences are:

1. Path resolution function: `getDuplicateWorkflowProjectPath(...)` vs `getUploadedWorkflowProjectPath(...)`
2. ENOENT error message: `'Project not found'` vs `'Folder not found'`
3. Everything else — serialization, `writeFile` with `flag: 'wx'`, EEXIST retry, metadata assignment — is identical.

**Where:** `workflow-mutations.ts`, new module-level function.

**What to change:**
```ts
async function writeUniqueProjectFile(
  getPathForIndex: (index: number) => { projectName: string; projectPath: string },
  project: Project,
  attachedData: AttachedData | undefined,
  projectId: string,
  root: string,
  notFoundMessage: string,
): Promise<WorkflowProjectItem> {
  for (let index = 0; ; index += 1) {
    const { projectName, projectPath } = getPathForIndex(index);
    project.metadata.id = projectId;
    project.metadata.title = projectName;

    let serialized: string;
    try {
      serialized = serializeProject(project, attachedData);
      if (typeof serialized !== 'string') throw new Error('...');
    } catch { throw createHttpError(400, '...'); }

    try {
      await fs.writeFile(projectPath, serialized, { encoding: 'utf8', flag: 'wx' });
      return getWorkflowProject(root, projectPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw createHttpError(404, notFoundMessage);
      throw error;
    }
  }
}
```

Both callers become ~10 lines: prepare their path-resolution callback and call `writeUniqueProjectFile`.

**How to verify:** Run workflow mutation tests — specifically duplicate and upload test cases. Verify EEXIST retry and ENOENT error behaviors.

**Estimated savings:** ~40 lines (corrected from ~50 — the helper function itself takes ~25 lines)

**Risks:**
- The path resolution functions have different signatures (`getDuplicateWorkflowProjectPath` takes 5 args, `getUploadedWorkflowProjectPath` takes 3). The callback abstraction must accommodate this via closures at the call site.
- The error message in the `try/catch` around serialization differs (`'Could not duplicate project'` vs `'Could not upload project'`). Parameterize this too, or use a generic message.

---

## 5. Backend: Publication

**File:** `wrapper/api/src/routes/workflows/publication.ts` (398 lines)

### 5.1 Merge findPublished and findLatest endpoint lookups `P1`

Verified: `findPublishedWorkflowByEndpoint()` (lines ~291-315) and `findLatestWorkflowByEndpoint()` (lines ~317-335) share ~75% of their code (corrected from ~90%). Both:
1. Call `listProjectPathsRecursive(root)`
2. Iterate project paths
3. Call `path.basename()` and `readStoredWorkflowProjectSettings()`
4. Check `isWorkflowEndpointPublished()`

They differ in:
- `findPublished` performs an additional validation step: calls `resolvePublishedWorkflowProjectPath()` and skips if it returns null
- `findPublished` returns `{ endpointName, projectPath, publishedProjectPath }` (3 fields)
- `findLatest` returns `{ endpointName, projectPath }` (2 fields)

**Where:** `publication.ts`.

**What to change:** Extract the shared scan into a helper:
```ts
async function findWorkflowByEndpoint(
  root: string,
  endpointName: string,
): Promise<{ projectPath: string; settings: WorkflowProjectSettings } | null> {
  const projectPaths = await listProjectPathsRecursive(root);
  for (const projectPath of projectPaths) {
    const projectName = path.basename(projectPath, PROJECT_EXTENSION);
    const settings = await readStoredWorkflowProjectSettings(projectPath, projectName);
    if (isWorkflowEndpointPublished(settings, endpointName)) {
      return { projectPath, settings };
    }
  }
  return null;
}
```

`findPublishedWorkflowByEndpoint` calls this, then does its extra resolution step.
`findLatestWorkflowByEndpoint` calls this and returns directly.

**How to verify:** Run publication tests and endpoint resolution tests in filesystem mode.

**Estimated savings:** ~15 lines (corrected from ~25 — the shared portion is shorter than initially estimated)

**Risks:**
- Low. The shared logic is a pure scan with no side effects. The extra resolution step in `findPublished` stays in its own function.

### 5.2 Simplify settings normalization `P2`

**Where:** `publication.ts`, `normalizeStoredWorkflowProjectSettings()`.

**What to change:** Use a defaults-and-override pattern instead of deeply nested ternaries. Apply explicit field validation only where the raw value needs type coercion (e.g., ensuring `lastPublishedAt` is a valid ISO string).

**How to verify:** Run settings normalization tests.

**Estimated savings:** ~15 lines

**Risks:**
- The current ternary chain may include implicit type coercion or null-vs-undefined distinctions. A spread pattern must preserve these semantics exactly.

---

## 6. Backend: Native IO

**File:** `wrapper/api/src/routes/native-io.ts` (319 lines)

### 6.1 Extract managed-workflow guard into a helper `P1` *(reclassified from P0)*

Verified: 8 functions check the managed-workflow condition (not just "check if path is managed" — the pattern is `!baseDir && isManagedWorkflowStorageEnabled() && isManagedWorkflowVirtualReference(path)`). However, the managed-path behavior is **fundamentally different** across functions:

- `readNativeText`, `readNativeBinary`, `readNativeRelative`: Delegate to managed read helpers
- `writeNativeText`, `writeNativeBinary`, `removeNativeFile`: **Throw errors** — managed writes are rejected
- `nativePathExists`: Complex virtual path resolution with special root-path and extension logic
- `listNativeDirectory`: Complex virtual entry filtering

A generic `withManagedRouting` higher-order function would NOT work for all 8 because the managed paths range from simple delegation to error throwing to complex multi-step logic.

**Where:** `native-io.ts`.

**What to change:** Extract only the repeated guard condition into a helper:
```ts
function isManagedVirtualPath(filePath: string, baseDir: string | undefined): boolean {
  return !baseDir && isManagedWorkflowStorageEnabled() && isManagedWorkflowVirtualReference(filePath);
}
```

This replaces the 3-part condition in all 8 functions with `if (isManagedVirtualPath(filePath, baseDir))`. The managed-path bodies stay inline because they are too different to abstract uniformly.

Note: `readNativeRelative` omits the `!baseDir` check — verify this is intentional before applying the helper.

**How to verify:** Run native-io tests and managed-mode Playwright tests.

**Estimated savings:** ~15 lines (corrected significantly from ~80 — only the guard condition is extractable, not the bodies)

**Risks:**
- `readNativeRelative` uses `relativeFrom` instead of `filePath` and omits the `!baseDir` check. This function may need its own guard variant or to be excluded from the helper.
- The guard function introduces a level of indirection that makes it slightly less obvious what the condition checks. Keep the helper adjacent to the functions that use it.

---

## 7. Backend: Execution Service

**File:** `wrapper/api/src/routes/workflows/managed/execution-service.ts` (392 lines)

### 7.1 Extract retry-after-invalidation pattern `P1`

Verified: The pattern appears 4 times — twice in `#loadExecutionProjectByEndpointOnce()` (lines ~215-224 and ~231-240) and twice in `#loadExecutionReferencedProject()` (lines ~351-359 and ~362-370). Each occurrence is identical:

```ts
if (workflowSnapshot && this.#invalidationController.shouldRetryAfterMaterialize(snapshot, workflowId)) {
  if (remainingInvalidationRetries > 0) {
    return this.#loadExecutionProjectByEndpointOnce(runKind, endpointName, remainingInvalidationRetries - 1);
  }
  throw createHttpError(503, 'Workflow endpoint changed while loading. Retry the request.');
}
```

**Where:** `execution-service.ts`, new private method.

**What to change:**
```ts
#checkInvalidationRetry(
  snapshot: GenerationSnapshot,
  workflowId: string,
  remainingRetries: number,
  retryFn: (retriesLeft: number) => Promise<T>,
): void | never {
  if (this.#invalidationController.shouldRetryAfterMaterialize(snapshot, workflowId)) {
    if (remainingRetries > 0) {
      return retryFn(remainingRetries - 1);
    }
    throw createHttpError(503, 'Workflow endpoint changed while loading. Retry the request.');
  }
}
```

Each call site becomes:
```ts
if (workflowSnapshot) {
  const retry = this.#checkInvalidationRetry(snapshot, workflowId, remaining, (n) => this.#loadExecutionProjectByEndpointOnce(runKind, endpointName, n));
  if (retry) return retry;
}
```

**How to verify:** Run managed-execution-invalidation tests.

**Estimated savings:** ~25 lines

**Risks:**
- The retry function returns a `Promise<T>` which means the type signature of the helper must propagate the generic correctly.
- Two of the 4 occurrences are in `#loadExecutionReferencedProject` which has a different retry target function. The helper must accept the retry function as a parameter.

---

## 8. Frontend: WorkflowLibraryPanel

**File:** `wrapper/web/dashboard/WorkflowLibraryPanel.tsx` (1,372 lines)

### 8.1 Group related state variables `P1` *(reclassified from P0)*

Verified: There are **22** `useState` calls (not 40+ as originally claimed). Several are genuinely related:

- **Download state (3):** `downloadModalProject`, `downloadingProjectPath`, `downloadingVersion`
- **Duplicate state (3):** `duplicateModalProject`, `duplicatingProjectPath`, `duplicatingVersion`
- **Drag state (3):** `draggedItem`, `dropTargetFolderPath`, `dragOverRoot`
- **Settings modal (2):** `settingsModalOpen`, `settingsModalProject` — could merge into just `settingsModalProject` (null = closed)

**Where:** `WorkflowLibraryPanel.tsx`, state declarations (lines ~360-390).

**What to change:** Group the download/duplicate states into compound objects:
```ts
const [downloadState, setDownloadState] = useState<{
  modalProject: WorkflowProjectItem | null;
  activePath: string | null;
  activeVersion: WorkflowProjectDownloadVersion | null;
}>({ modalProject: null, activePath: null, activeVersion: null });
```

Same for duplicate state. Replace `settingsModalOpen` + `settingsModalProject` with just `settingsModalProject` (null means closed).

This reduces 22 `useState` calls to ~16.

**How to verify:** Manual UI testing of download, duplicate, and settings modals. Existing Playwright tests.

**Estimated savings:** ~15 lines

**Risks:**
- Compound state objects require spreading when updating a single field: `setDownloadState(prev => ({ ...prev, activePath: path }))`. This is slightly more verbose per update. Net savings still positive because there are fewer state declarations and fewer setter functions to pass around.
- React re-renders: Compound state triggers re-render on any field change. All fields in each group are set together or cleared together, so this is not a concern in practice.

### 8.2 Deduplicate download/duplicate modal rendering `P0`

Verified: Two `WorkflowProjectDownloadModal` instances (lines ~1328-1348 and ~1349-1369) are 99% identical. Differences:
- `actionLabel`: `"Download"` vs `"Duplicate"`
- `isOpen` / `onClose`: Different state variables
- `onSelectPublished` / `onSelectUnpublishedChanges`: Call `startDownloadProject` vs `startDuplicateProject`
- `activeVersion`: Computed from different state

**Where:** `WorkflowLibraryPanel.tsx`, modal rendering section.

**What to change:** Track the active modal mode and render one instance:
```ts
const [activeProjectModal, setActiveProjectModal] = useState<{
  project: WorkflowProjectItem;
  mode: 'download' | 'duplicate';
} | null>(null);

// In JSX:
<WorkflowProjectDownloadModal
  isOpen={activeProjectModal != null}
  project={activeProjectModal?.project ?? null}
  actionLabel={activeProjectModal?.mode === 'download' ? 'Download' : 'Duplicate'}
  activeVersion={...}
  onClose={() => setActiveProjectModal(null)}
  onSelectPublished={() => {
    const handler = activeProjectModal?.mode === 'download' ? startDownloadProject : startDuplicateProject;
    handler(activeProjectModal!.project, 'published', { closeModal: true });
  }}
  onSelectUnpublishedChanges={() => { /* same pattern */ }}
/>
```

This also eliminates 2 separate state variables (`downloadModalProject`, `duplicateModalProject`) and their setters.

**How to verify:** Manual UI testing of both download and duplicate flows. Existing Playwright tests.

**Estimated savings:** ~20 lines

**Risks:**
- Minimal. The modal component is stateless — it receives all behavior through props. The only change is which props are passed.

### 8.3 Extract tree manipulation utilities `P1`

Verified: 7 pure functions spanning lines ~60-276 (217 lines total):
- `remapExpandedFolderIds` (33 lines)
- `rewriteWorkflowPathPrefix` (15 lines)
- `rewriteProjectForFolderMove` (9 lines)
- `rewriteFolderTreeForFolderMove` (35 lines)
- `detachFolderFromTree` (39 lines)
- `insertFolderIntoTree` (44 lines)
- `applyFolderMoveToTree` (36 lines)

All are pure functions with no React imports, no hooks, no state dependencies. They operate on `WorkflowFolderItem[]` and `WorkflowProjectItem[]` types.

**Where:** New file `wrapper/web/dashboard/workflowTreeOps.ts`.

**What to change:** Move all 7 functions verbatim. Add imports in `WorkflowLibraryPanel.tsx`.

**How to verify:** All existing tests and Playwright flows. The functions are unchanged.

**Estimated savings:** 0 net lines, but the component file shrinks by 217 lines.

**Risks:**
- Minimal. Pure function extraction with no behavioral change.
- Ensure all types used by the tree functions are importable from `wrapper/shared/workflow-types.ts` or the local `types.ts`.

---

## 9. Frontend: OverlayTabs

**File:** `wrapper/web/overrides/components/OverlayTabs.tsx` (320 lines)

### 9.1 Data-drive the menu items `P1`

Verified: 8 menu items, 7 of which are identical in structure. The exception is **Trivet Tests** which conditionally renders a `LoadingSpinner` inside the button.

**Where:** `OverlayTabs.tsx`.

**What to change:** Define a config array:
```ts
type MenuItem = {
  id: string;
  label: string;
  overlay: OverlayType | undefined; // undefined = canvas (no overlay)
  hidden?: boolean;
  suffix?: React.ReactNode;
};

const menuItems: MenuItem[] = [
  { id: 'canvas', label: 'Canvas', overlay: undefined },
  { id: 'plugins', label: 'Plugins', overlay: 'promptDesigner' },
  // ...
  { id: 'trivet', label: 'Trivet Tests', overlay: 'trivet', suffix: /* LoadingSpinner logic */ },
];
```

Render with `.filter(item => !item.hidden).map(item => <MenuItemButton key={item.id} ... />)`.

The Trivet `suffix` prop handles its special `LoadingSpinner` without breaking the pattern.

**How to verify:** Manual UI testing of all menu items including Trivet with running tests.

**Estimated savings:** ~50 lines (corrected from ~60 — the config array + MenuItem component add ~20 lines)

**Risks:**
- The Trivet item's `LoadingSpinner` depends on `trivet.runningTests` from a React hook. The `suffix` must be computed inside the component body (not at module level), so the config array must be built inside the component or the suffix must be a render function.
- Community menu item has a feature-flag conditional for `hidden`. This works cleanly with the `hidden` prop.

---

## 10. Frontend: useRemoteExecutor

**File:** `wrapper/web/overrides/hooks/useRemoteExecutor.ts` (385 lines)

### 10.1 Replace message handler switch with dispatch map `P1`

Verified: 17 switch cases. 12 follow the uniform `currentExecution.onXxx(data)` pattern. 5 have special logic:
- `done`: Resolves `graphExecutionPromise` before calling `onDone`
- `abort`: Rejects `graphExecutionPromise` before calling `onAbort`
- `error`: Rejects `graphExecutionPromise` before calling `onError`
- `trace`: Calls `logRemoteTrace(data)` instead of `currentExecution.onTrace`
- `pause`/`resume`: Call handlers with no data parameter

**Where:** `useRemoteExecutor.ts`, the switch statement (lines ~130-189).

**What to change:** Extract only the 12 uniform cases into a dispatch map:
```ts
const simpleHandlers: Record<string, (data: any) => void> = {
  nodeStart: (d) => currentExecution.onNodeStart(d),
  nodeFinish: (d) => currentExecution.onNodeFinish(d),
  nodeError: (d) => currentExecution.onNodeError(d),
  userInput: (d) => currentExecution.onUserInput(d),
  start: (d) => currentExecution.onStart(d),
  partialOutput: (d) => currentExecution.onPartialOutput(d),
  graphStart: (d) => currentExecution.onGraphStart(d),
  graphFinish: (d) => currentExecution.onGraphFinish(d),
  nodeOutputsCleared: (d) => currentExecution.onNodeOutputsCleared(d),
  graphAbort: (d) => currentExecution.onGraphAbort(d),
  nodeExcluded: (d) => currentExecution.onNodeExcluded(d),
  pause: () => currentExecution.onPause(),
};
```

The 5 special cases remain as explicit switch cases after the map lookup fails. Overall dispatch:
```ts
const handler = simpleHandlers[type];
if (handler) {
  handler(data);
} else {
  switch (type) {
    case 'done': /* ... */
    case 'abort': /* ... */
    case 'error': /* ... */
    case 'trace': /* ... */
    case 'resume': /* ... */
  }
}
```

**How to verify:** Run existing execution tests. Manual testing of workflow execution including abort, error, and trace scenarios.

**Estimated savings:** ~20 lines (corrected from ~30 — 5 special cases must remain as explicit handlers)

**Risks:**
- The dispatch map loses compile-time exhaustiveness checking that a switch statement provides. If a new message type is added upstream, it will silently be ignored instead of triggering a missing-case warning. Mitigate by adding a `default` log in the fallback switch.
- `pause` takes no data parameter but is included in the map — ensure the handler ignores data correctly.

---

## 11. Ops: Docker Launcher Scripts

**Files:**
- `scripts/dev-docker.mjs` (186 lines)
- `scripts/prod-docker.mjs` (234 lines)

### 11.1 Extract shared launcher logic `P0`

Verified: ~58-64% of code is identical between the two files. Shared portions:
- `run()` function (identical, ~22 lines)
- `runCapture()` function (identical, ~32 lines)
- `assertValidPort()` function (identical, ~8 lines)
- `ensurePortAvailable()` logic (~15 lines)
- `isComposeServiceRunning()` logic (~10 lines)
- `printFailureDiagnostics()` logic (~15 lines)
- Compose profile detection for managed mode (~10 lines)

Mode-specific portions that must stay separate:
- Default action name (`'dev'` vs `'prod'`)
- Compose file path
- Error message prefixes
- `prod-docker.mjs` has additional actions (`prod-prebuilt`, `recreate-prebuilt`, `auto` mode — ~42 lines of unique logic)
- Different build service lists

**Where:** New file `scripts/lib/docker-launcher.mjs`.

**What to change:** Move all shared functions into the new module and export them:
```js
// scripts/lib/docker-launcher.mjs
export function run(command, env, options) { ... }
export function runCapture(command, env, options) { ... }
export function assertValidPort(port, name) { ... }
export function ensurePortAvailable(port, name) { ... }
export function isComposeServiceRunning(composePath, service, env) { ... }
export function printFailureDiagnostics(composePath, env) { ... }
export function detectComposeProfiles(env) { ... }
```

Each launcher script imports from the shared module and adds only its mode-specific dispatch.

**How to verify:** Run `npm run dev-docker -- help` and `npm run prod-docker -- help`. Both should produce the same help output. Test at least one `dev` and one `prod` compose action.

**Estimated savings:** ~100 lines (corrected from ~120 — some shared logic has minor config differences that require parameterization)

**Risks:**
- The `run()` and `runCapture()` functions use `rootDir` as `cwd`, which is defined as a module-level constant in each script. The shared module must accept `cwd` as a parameter or derive it from `import.meta.url`.
- Error message prefixes (`[dev-docker]` vs `[prod-docker]`) are used in the shared logic. Parameterize with a `label` argument.

### 11.2 Extract process runner utilities `P0` *(reclassified — verify-compatibility has incompatible versions)*

Verified: `scripts/verify-compatibility.mjs` has its own `run()` and `runCapture()` but they are **NOT identical** to the docker scripts:
- Different return types: verify's `run()` returns `void` (resolves undefined), docker's returns `exitCode` (number)
- Different signatures: verify's `runCapture()` returns `{ stdout, stderr }`, docker's returns `{ exitCode, stdout, stderr }`
- No `allowFailure` option support in verify's version

**Revised action:** Extract `run()` and `runCapture()` from the docker scripts into `scripts/lib/docker-launcher.mjs` (covered by 11.1). Do NOT try to unify with `verify-compatibility.mjs` — the signatures are incompatible and forcing compatibility would be overengineering.

**Estimated savings:** Included in 11.1's savings. Remove this as a separate item.

**Risks:** N/A — item merged into 11.1.

---

## 12. Ops: Nginx Configuration *(REMOVED)*

**Files:**
- `ops/nginx.conf` (188 lines)
- `ops/nginx.dev.conf` (182 lines)

**Original claim:** 95% identical, merge with `envsubst`.

**Verified reality:** The differences are **structural**, not just variable substitution:
- Prod uses upstream **variables** (`$web_upstream`, `$api_upstream`) set in a `set` block. Dev uses **hardcoded** hostnames (`http://web:5174`, `http://api`).
- Dev has a `resolver` directive (line 3) that prod does not.
- Dev has extra `proxy_cache_bypass` and `proxy_http_version` headers in the root location that prod does not.
- The upstream-variable vs direct-hostname difference is architectural: prod needs dynamic resolution for Kubernetes Service names.

`envsubst` cannot handle conditional blocks. `nginx.conf` `if` directives are notoriously fragile. Merging would require a templating engine (envsubst cannot do it) and would make the nginx config harder to understand.

**Decision:** Remove this item. The two configs serve genuinely different deployment modes and are better kept separate. They are not that large (188 + 182 lines) and diverge in important ways.

---

## 13. Ops: Docker Compose *(DOWNGRADED)*

**Files:**
- `ops/docker-compose.yml` (231 lines)
- `ops/docker-compose.dev.yml` (296 lines)

### 13.1 Extract shared managed-mode services only `P2` *(reclassified from P1)*

**Verified reality:** Only the managed-mode services (workflow-postgres, workflow-minio, workflow-minio-init) are truly identical (~47 lines). The proxy differs only in one line (nginx config filename). But web, api, and executor services are **fundamentally different**:
- Dev uses `node:20-alpine` with live-reload scripts and source mounts
- Prod uses prebuilt container images
- Dev has extra volumes for `node_modules` caches
- Different healthcheck timings, different exposed ports

Docker Compose `extends` would work only for the 3 managed-mode services and proxy. The main workload services are too different to share.

**Where:** New file `ops/docker-compose.managed-services.yml`.

**What to change:** Move the 3 identical managed-mode service definitions (workflow-postgres, workflow-minio, workflow-minio-init) into a shared file. Both dev and prod compose files include it via `-f ops/docker-compose.managed-services.yml -f ops/docker-compose.yml`.

**How to verify:** Run `npm run dev-docker dev` and `npm run prod-docker prod` with `RIVET_STORAGE_MODE=managed`.

**Estimated savings:** ~40 lines (corrected from ~150 — only managed services are truly sharable)

**Risks:**
- Docker Compose multi-file composition (`-f`) changes the project directory context, which can break relative paths for volume mounts. Verify all `./` relative paths still resolve correctly.
- The managed-mode services use `profiles: ["workflow-managed"]`, which must still work correctly across the multi-file setup.
- Complexity cost: Developers must now understand a 3-file compose setup instead of a self-contained single file. This may not be worth the ~40 lines saved.

---

## 14. Ops: Proxy Bootstrap

**File:** `ops/proxy-bootstrap/sync.mjs` (491 lines)

### 14.1 Extract replica status reporting error handling `P2`

**Where:** `sync.mjs`.

**What to change:** Extract the repeated "try to write, catch undefined-table error, log once and skip" pattern:
```js
async function safeReplicaStatusWrite(label, fn) {
  try {
    await fn();
  } catch (err) {
    if (getPgErrorCode(err) === REPLICA_STATUS_UNDEFINED_TABLE_CODE) {
      if (!undefinedTableWarned) { log(...); undefinedTableWarned = true; }
      return;
    }
    throw err;
  }
}
```

**How to verify:** Run managed mode with the executor and API. Verify replica status writes still work and undefined-table errors are still handled gracefully.

**Estimated savings:** ~25 lines

**Risks:**
- The `undefinedTableWarned` flag is currently module-scoped. The helper must share this flag or accept it as a parameter.

### 14.2 Consolidate env normalization helpers `P2`

**Where:** `ops/proxy-bootstrap/config.mjs`.

**What to change:** Extract a generic parser:
```js
function parseEnv(name, parser, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return defaultValue;
  return parser(raw.trim());
}
```

`normalizeBoolean` becomes `parseEnv(name, v => ['1','true','yes','on'].includes(v.toLowerCase()), false)`.
`normalizePositiveInt` becomes `parseEnv(name, v => Math.max(1, parseInt(v, 10) || default), default)`.

**How to verify:** Run proxy-bootstrap in managed mode.

**Estimated savings:** ~12 lines

**Risks:**
- Minimal. Pure utility extraction.

---

## 15. Backend: Duplicated Config Parsing Utilities *(NEW — gap in original plan)*

**Files:**
- `wrapper/api/src/routes/workflows/storage-config.ts`
- `wrapper/api/src/routes/runtime-libraries/config.ts`
- `wrapper/api/src/routes/workflows/recordings-config.ts`

### 15.1 Consolidate env parsing helpers `P0`

Verified: Three separate implementations of `normalizeBoolean()` with identical logic exist across these files. Two separate implementations of `normalizeEnumValue()` exist. Similar patterns for `parseIntegerEnv()` / `normalizePositiveInt()` appear with different names.

**Where:** New file `wrapper/api/src/utils/env-parsing.ts`.

**What to change:** Create shared helpers:
```ts
export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function parseEnum<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  const normalized = value?.trim().toLowerCase();
  return allowed.includes(normalized as T) ? (normalized as T) : fallback;
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const parsed = parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
```

Replace all 3 `normalizeBoolean` implementations, both `normalizeEnumValue` implementations, and the integer parsing variants with imports from the shared module.

**How to verify:** Run storage-config tests, runtime-library tests, and recording-config tests.

**Estimated savings:** ~50 lines

**Risks:**
- The three implementations have subtle differences in edge case handling (e.g., `parseBooleanEnv` in recordings-config checks `value == null` separately before trimming, while `normalizeBoolean` in storage-config checks `!normalized` after trimming). Verify that the shared implementation handles all edge cases from all three versions.
- The recordings-config version uses the name `parseBooleanEnv` rather than `normalizeBoolean`. Update all call sites.

---

## Summary

| # | Area | Priority | Estimated Savings | Risk |
|---|------|----------|-------------------|------|
| 1.1 | Managed backend SQL constants | P0 | ~60 lines | Low |
| 1.2 | Managed backend recording helpers | P0 | ~50 lines | Medium |
| 1.5 | Managed backend recording error cleanup | P0 | (included in 1.2) | — |
| 2.1 | Storage backend delegator | P0 | ~80 lines | Low |
| 3.1 | Recordings-db SQL constants | P0 | ~85 lines | Low |
| 4.1 | Mutation retry loop dedup | P0 | ~40 lines | Low |
| 8.2 | WorkflowLibraryPanel modal dedup | P0 | ~20 lines | Low |
| 11.1 | Docker launcher shared logic | P0 | ~100 lines | Low |
| 15.1 | Consolidate env parsing helpers | P0 | ~50 lines | Low |
| 1.3 | Managed backend class split | P1 | structural | High |
| 1.4 | Managed backend rollback dedup | P2 | ~10 lines | Low |
| 3.2 | Recordings-db WHERE builder | P2 | ~8 lines | Low |
| 3.3 | Recordings normalization | P1 | ~40 lines | Medium |
| 3.4 | Recordings artifact helpers | P2 | ~12 lines | Low |
| 5.1 | Publication endpoint lookup merge | P1 | ~15 lines | Low |
| 5.2 | Publication settings normalization | P2 | ~15 lines | Medium |
| 6.1 | Native IO managed guard helper | P1 | ~15 lines | Low |
| 7.1 | Execution retry pattern | P1 | ~25 lines | Medium |
| 8.1 | WorkflowLibraryPanel state groups | P1 | ~15 lines | Low |
| 8.3 | WorkflowLibraryPanel tree ops extract | P1 | structural | Low |
| 9.1 | OverlayTabs data-driven menu | P1 | ~50 lines | Low |
| 10.1 | useRemoteExecutor dispatch map | P1 | ~20 lines | Medium |
| 13.1 | Docker Compose shared services | P2 | ~40 lines | Medium |
| 14.1 | Bootstrap error handling | P2 | ~25 lines | Low |
| 14.2 | Bootstrap env normalization | P2 | ~12 lines | Low |

**Removed items:**
- ~~11.2 Process runner extract~~ — verify-compatibility has incompatible signatures; merged into 11.1
- ~~12.1 Nginx config merge~~ — differences are structural, not variable; merge would hurt clarity

**Total estimated savings:** ~835 lines of code removed or deduplicated (corrected from ~1,350 after deep verification).

P0 items account for ~485 lines and carry the lowest risk.

---

## Execution Order

Recommended order to minimize risk and maximize early impact:

**Phase 1: P0 mechanical deduplication** (items 1.1, 1.2, 2.1, 3.1, 4.1, 8.2, 11.1, 15.1)
- Pure extraction, no logic changes, testable immediately
- Run full test suite after each item

**Phase 2: P1 structural improvements** (items 3.3, 5.1, 6.1, 7.1, 8.1, 8.3, 9.1, 10.1)
- Slightly more involved, but still behavior-preserving
- Each item is independent

**Phase 3: P1 high-risk structural** (item 1.3)
- The managed backend class split depends on 1.1 and 1.2 being done first
- This is the only item with a dependency on other items

**Phase 4: P2 polish** (items 1.4, 3.2, 3.4, 5.2, 13.1, 14.1, 14.2)
- Do when touching nearby code

Within each phase, items are independent and can be done in any order — except 1.3 which requires 1.1 and 1.2 first.
