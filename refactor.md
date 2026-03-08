# Refactor Plan

This document describes a set of refactoring changes to reduce complexity, remove unnecessary code, and make the codebase more transparent and maintainable. All changes preserve existing functionality. Nothing inside `rivet/` is touched.

---

## 1. DONE - Split `workflows.ts` (1080 lines) into focused modules

**File:** `wrapper/api/src/routes/workflows.ts`

This is the largest file in the codebase and mixes three distinct concerns in one module: workflow CRUD management, publication/snapshot logic, and workflow execution. It also defines all its own types inline.

**Changes:**

- **Extract types** into `wrapper/api/src/routes/workflows/types.ts` — lines 18-71: `WorkflowProjectStatus`, `WorkflowProjectSettings`, `StoredWorkflowProjectSettings`, `WorkflowProjectItem`, `WorkflowFolderItem`, `WorkflowProjectPathMove`, `PublishedWorkflowMatch`, `LatestWorkflowMatch`, `WorkflowProjectSettingsDraft`.

- **Extract filesystem helpers** into `wrapper/api/src/routes/workflows/fs-helpers.ts`:
  - `ensureWorkflowsRoot` (line 450)
  - `sanitizeWorkflowName` (line 457)
  - `resolveWorkflowRelativePath` (resolves and validates relative paths)
  - `pathExists` (fs.access wrapper)
  - `ensurePathDoesNotExist` (conflict check helper)
  - `getWorkflowProjectSettingsPath` (line 731)
  - `getPublishedSnapshotsRoot`, `getPublishedWorkflowSnapshotPath`, `getPublishedWorkflowSnapshotDatasetPath`
  - `getWorkflowDatasetPath` (line 747)
  - `listProjectPathsRecursive`
  - `createBlankProjectFile` (line 1057), `quoteForYaml` (line 1053)

- **Extract settings/publication logic** into `wrapper/api/src/routes/workflows/publication.ts`:
  - `readStoredWorkflowProjectSettings` (line 763)
  - `writeStoredWorkflowProjectSettings` (line 780)
  - `createDefaultStoredWorkflowProjectSettings`
  - `normalizeWorkflowProjectSettingsDraft`, `normalizeStoredWorkflowProjectSettings` (line 803)
  - `getDerivedWorkflowProjectStatus` (line 843)
  - `normalizeStoredEndpointName` (line 1038)
  - `isWorkflowEndpointPublished`, `ensureWorkflowEndpointNameIsUnique` (line 858)
  - `createWorkflowPublicationStateHash` (line 1023)
  - `getWorkflowProjectSettings` (builds the full settings object with derived status)
  - `writePublishedWorkflowSnapshot` (line 879), `deletePublishedWorkflowSnapshot` (line 893)
  - `resolvePublishedWorkflowProjectPath`
  - `findPublishedWorkflowByEndpoint` (line 909), `findLatestWorkflowByEndpoint`
  - `createPublishedWorkflowProjectReferenceLoader`

- **Extract execution routers** into `wrapper/api/src/routes/workflows/execution.ts`:
  - `publishedWorkflowsRouter` (lines 80-131) and `latestWorkflowsRouter` (lines 133-184)
  - Extract a shared `executeWorkflowEndpoint(projectPath, referenceProjectPath, root, req, res)` helper (see Item 2)
  - Both route handlers become ~10 lines each: resolve endpoint, find workflow, call shared helper

- **Keep** `wrapper/api/src/routes/workflows/index.ts` as the slim management router (`workflowsRouter`) containing the CRUD route handlers (`GET /tree`, `POST /folders`, `PATCH /folders`, `DELETE /folders`, `POST /projects`, `PATCH /projects`, `DELETE /projects`, `POST /projects/publish`, `POST /projects/unpublish`, `POST /move`). Re-export the execution routers and types.

- **Also extract** `getWorkflowProject` (builds a `WorkflowProjectItem` from a path), `listWorkflowFolders`, `listWorkflowProjects`, `moveWorkflowProject` (line 572) into appropriate modules — these are currently helper functions called by the route handlers.

**Why:** A 1080-line module with 40+ functions is hard to navigate. Splitting by concern makes each piece independently understandable and testable. The near-duplicate execution handlers become a single shared function.

---

## 2. DONE - Deduplicate published/latest workflow execution handlers

**File:** `wrapper/api/src/routes/workflows.ts`, lines 80-184

The `publishedWorkflowsRouter.post` (lines 80-131) and `latestWorkflowsRouter.post` (lines 133-184) handlers are nearly identical. Both:
1. Normalize and validate the endpoint name
2. Look up the workflow (different lookup function, different match type)
3. Call `loadProjectFromFile` with the resolved project path
4. Create a `NodeDatasetProvider` from the same path
5. Create a `projectReferenceLoader` with `createPublishedWorkflowProjectReferenceLoader`
6. Call `runGraph` with identical input structure (`{ input: { type: 'any', value: { payload: req.body } } }`)
7. Extract `outputs.output` with the same conditional (`type === 'any'` check)
8. Format errors with the same `error instanceof Error ? { name, message, stack } : { message: String(error) }` pattern

The only differences: `findPublishedWorkflowByEndpoint` vs `findLatestWorkflowByEndpoint`, and `publishedProjectPath` vs `projectPath` as the load path.

**Changes:**

- Extract a shared function:
  ```ts
  async function executeWorkflowEndpoint(
    loadPath: string,          // path to load project from (snapshot or live)
    referencePath: string,     // path for project reference resolution
    root: string,              // workflows root for reference loader
    req: Request,
    res: Response,
  ): Promise<void>
  ```
  This contains the try/catch, `loadProjectFromFile`, `NodeDatasetProvider.fromProjectFile`, `runGraph`, output extraction, and error formatting (lines 93-131 / 146-184).
- Both route handlers call this with their respective resolved paths.

**Impact:** Removes ~40 lines of duplicated code and a maintenance trap (changes to error formatting or output extraction currently need to be made in two places).

---

## 3. DONE - Remove excessive debug logging from save-shortcut handling

**Files:**
- `wrapper/web/dashboard/DashboardPage.tsx`
- `wrapper/web/dashboard/EditorMessageBridge.tsx`

The Ctrl+S / Cmd+S shortcut handling has 25+ `console.log` calls with a `[hosted-save-shortcut]` prefix across two files, logging every keystroke event with full context objects (`editorReady`, `hasIframeWindow`, `isIframeFocused`, `activeElementTag`, `targetTag`, `defaultPrevented`, `repeat`, etc.). This was debugging instrumentation that should not live in production code.

**In `DashboardPage.tsx`:**
- Line 11: `SAVE_SHORTCUT_DEBUG_PREFIX` constant definition
- Lines 35-38: `console.log` when queueing save-project command (inside `postEditorCommand`)
- Lines 44-49: `console.log` when posting save-project command to iframe (inside `postEditorCommand`)
- Lines 92-96: `console.log` when flushing queued save-project command (inside `useEffect`)
- Lines 112-122: `console.log` when ignoring keydown (not save shortcut or not ready)
- Lines 126-134: `console.log` when observing save shortcut
- Line 137: `console.log` when letting iframe handle save shortcut
- Line 143: `console.log` when handling save shortcut in dashboard

**In `EditorMessageBridge.tsx`:**
- Line 18: `SAVE_SHORTCUT_DEBUG_PREFIX` constant definition
- Lines 55-62: `console.log` when observing keydown
- Lines 67-70: `console.log` after preventing browser default
- Line 73: `console.log` for non-Windows save
- Line 76: `console.log` for Windows keyup waiting
- Lines 97-103: `console.log` when observing Windows keyup
- Line 108: `console.log` when calling saveProject from Windows keyup handler
- Lines 121-124: `console.log` when receiving save-project message from parent

**Changes:**
- Delete both `SAVE_SHORTCUT_DEBUG_PREFIX` constants and all associated `console.log` calls listed above.
- Keep all actual shortcut logic (`event.preventDefault()`, `event.stopPropagation()`, `saveCurrentProject()`, `handleSaveProject()`) intact.

**Impact:** Removes ~40 lines of noise. Makes the shortcut handling logic readable at a glance.

---

## 4. DONE - Remove development-era debug logging from useRemoteDebugger

**File:** `wrapper/web/overrides/hooks/useRemoteDebugger.ts`

**Lines to remove:**
- Line 191: `logHostedDebug('log', '%c[HOSTED-OVERRIDE] useRemoteDebugger module loaded (singleton)', ...)` — fires once on module load. Served its purpose during initial development to verify the override was bundled. No longer needed.
- Line 199: `logHostedDebug('log', '[HOSTED-OVERRIDE] useRemoteDebugger render: started=%s ...')` — fires on **every React render**. This is excessive and pollutes logs.

**Lines to keep (useful for troubleshooting WebSocket issues, guarded behind `RIVET_DEBUG_LOGS` flag):**
- Line 97: `logHostedDebug('log', '[executor-ws] connected to', wsUrl)` — connection success
- Line 135: `logHostedDebug('log', '[executor-ws] graph upload allowed')` — upload state change
- Line 164: `logHostedDebug('log', '[executor-ws] doSend type=%s open=%s', ...)` — message send
- Line 172: `logHostedDebug('log', '[executor-ws] doSendRaw open=%s len=%d', ...)` — raw send

**Impact:** Removes 2 log lines that fire on module load and every render. The remaining `logHostedDebug` calls are legitimate diagnostic logs behind a feature flag.

---

## 5. DONE - Simplify the Windows keyup save workaround in EditorMessageBridge

**File:** `wrapper/web/dashboard/EditorMessageBridge.tsx`, lines 48-116

The file has two separate `useEffect` hooks for save handling:
1. **Keydown handler** (lines 48-84): Listens on `document` for `keydown`. On all platforms, it calls `event.preventDefault()` + `event.stopPropagation()`. On non-Windows, it directly calls `saveCurrentProject()`. On Windows, it deliberately skips the save.
2. **Windows keyup handler** (lines 86-116): Only active when `isWindowsPlatform` is true. Listens on `window` for `keyup`. When it detects Ctrl+S keyup, it calls `saveCurrentProject()`.

The Windows workaround exists because in some browsers on Windows, `keydown` Ctrl+S inside an iframe may trigger browser "Save Page" before the handler can prevent it. By splitting to `keyup`, the keydown can prevent the default and the keyup performs the actual save.

**Changes:**

- Remove the wrapper-managed Windows `keyup` save effect entirely and keep a single iframe `keydown` handler that:
  1. Always calls `event.preventDefault()` + `event.stopPropagation()` on save shortcut
  2. On non-Windows: immediately calls `saveCurrentProject()`
  3. On Windows: does **not** call save directly and instead relies on Rivet's upstream `useWindowsHotkeysFix`, which already performs the actual save on `keyup`
- This preserves the correct Windows behavior while simplifying the wrapper code and avoiding double-save bugs inside the iframe.
- **Do NOT call save directly on Windows inside the iframe.** The upstream keyup-based workaround already exists and is required for correct browser behavior.

**Impact:** Reduces two wrapper save effects to one while keeping the real Windows workaround intact in upstream Rivet. The wrapper now only suppresses the browser default inside the iframe and performs hosted save directly on non-Windows.

---

## 6. DONE - Extract the settings modal from WorkflowLibraryPanel into its own component

**File:** `wrapper/web/dashboard/WorkflowLibraryPanel.tsx` (993 lines)

This component handles: tree rendering, drag-and-drop, folder CRUD, project CRUD, active project section, AND the full project settings modal with publish/unpublish/rename/delete/endpoint-editing logic. The settings modal alone accounts for ~130 lines of JSX and ~200 lines of supporting state/handlers.

**Changes:**

- Extract `ProjectSettingsModal` into `wrapper/web/dashboard/ProjectSettingsModal.tsx`.
  - Props: `activeProject: WorkflowProjectItem`, `isOpen: boolean`, `onClose: () => void`, `onRefresh: () => void`, `onDeleteProject: (path: string) => void`, `onWorkflowPathsMoved: (moves: WorkflowProjectPathMove[]) => void`.
  - Moves with it: `settingsDraft` / `projectNameDraft` / `editingProjectName` / `renamingProject` / `savingSettings` / `deletingProject` state, all their handlers (publish, unpublish, rename, delete, settings save), all the validation `useMemo`s (endpoint name validation, settings dirty check), and the `<ModalDialog>` JSX with its form fields.

- Extract `ActiveProjectSection` into `wrapper/web/dashboard/ActiveProjectSection.tsx`.
  - Props: `activeProject: WorkflowProjectItem`, `isCurrentlyOpen: boolean`, `editorReady: boolean`, `onSave: () => void`, `onOpen: (path: string) => void`, `onOpenSettings: () => void`.
  - This is the pinned section at the top of the sidebar that shows the current project name, status badge, and action buttons.

**Impact:** `WorkflowLibraryPanel` drops from ~993 lines to ~500 lines, focused on tree rendering and drag-and-drop. The settings modal and active project section become independently understandable.

---

## 7. DONE - Remove `wrapper/shared/api-types.ts` (dead code)

**File:** `wrapper/shared/api-types.ts` (104 lines)

This file defines typed request/response interfaces (`NativeReadTextRequest`, `ShellExecRequest`, `PluginInstallRequest`, etc.) but they are **not imported or used anywhere** in the codebase. Verified with: `grep -r "from.*api-types" wrapper/` returns zero matches. The shims and API routes use inline types or untyped request bodies.

**Changes:**
- Delete the file entirely.

**Why not wire them in instead?** The types describe a contract that the code already implements correctly. Adding imports to 15+ files across frontend and backend would be a large change for marginal benefit — the API is internal (same Docker network) and changes always touch both sides simultaneously. The types would also need to be kept in sync with two different module systems (ESM frontend, CJS-compat backend).

**Impact:** Removes 104 lines of dead code that creates the illusion of type safety without actually providing it.

---

## 8. DONE - Remove `server_old.js`

**File:** `server_old.js` (103 lines, repo root)

This is a legacy Express server from before the modular `wrapper/api/` rewrite. It has been superseded and is not referenced by any script, Dockerfile, or configuration.

**Changes:**
- Delete `server_old.js`.

**Impact:** Removes dead code that could confuse someone exploring the repo.

---

## 9. DONE - Consolidate the `constants.ts` one-liner

**File:** `wrapper/web/dashboard/constants.ts` (1 line)

Contains only: `export const WORKFLOW_DASHBOARD_SIDEBAR_WIDTH = '300px';`

This is used in exactly one place: `DashboardPage.tsx` line 27 (`parseInt(WORKFLOW_DASHBOARD_SIDEBAR_WIDTH, 10) || 300`). That file already defines `MIN_SIDEBAR_WIDTH = 240` and `MAX_SIDEBAR_WIDTH = 560` as local constants (lines 9-10).

**Changes:**
- Move `WORKFLOW_DASHBOARD_SIDEBAR_WIDTH` into `DashboardPage.tsx` alongside the existing `MIN_SIDEBAR_WIDTH` / `MAX_SIDEBAR_WIDTH` constants.
- Delete `constants.ts` and its import in `DashboardPage.tsx` (line 5).

**Impact:** One fewer file. Keeps related sidebar dimension constants together.

---

## 10. DONE - Remove duplicate type definitions between frontend and backend

**Files:**
- `wrapper/web/dashboard/types.ts` (48 lines) — frontend types
- `wrapper/api/src/routes/workflows.ts` lines 18-71 — backend types (inline)

Both sides define identical shapes:
- `WorkflowProjectStatus` = `'unpublished' | 'published' | 'unpublished_changes'`
- `WorkflowProjectSettings` = `{ status: WorkflowProjectStatus; endpointName: string }`
- `WorkflowProjectSettingsDraft` = `{ endpointName: string }`
- `WorkflowProjectItem` = `{ id, name, fileName, relativePath, absolutePath, updatedAt, settings }`
- `WorkflowFolderItem` = `{ id, name, relativePath, absolutePath, updatedAt, folders, projects }`
- `WorkflowProjectPathMove` = `{ fromAbsolutePath, toAbsolutePath }`

The frontend `types.ts` also defines frontend-only types:
- `WorkflowMoveResponse` = `{ folder?, project?, movedProjectPaths }`
- `WorkflowTreeResponse` = `{ root, folders, projects }`

**Changes:**
- Create `wrapper/shared/workflow-types.ts` with the 6 shared types listed above.
- Import them in both `wrapper/web/dashboard/types.ts` and the backend workflow routes.
- Keep `WorkflowMoveResponse`, `WorkflowTreeResponse` in `wrapper/web/dashboard/types.ts` (they're API response wrappers used only by the frontend).
- The backend also has `StoredWorkflowProjectSettings`, `PublishedWorkflowMatch`, `LatestWorkflowMatch` — keep these backend-only (they're internal, never sent to the frontend).

**Impact:** Single source of truth for the API contract. Type drift between frontend and backend becomes a compile error instead of a silent bug.

---

## 11. DONE - Consolidate the trivial no-op Tauri shims

**Files:** `wrapper/web/shims/` — 12 shim files total

The shim files fall into two categories:

**Substantive shims (keep as separate files — they contain real logic):**
- `tauri-apps-api-fs.ts` (265 lines) — routes all file operations through `/api/native/*` endpoints
- `tauri-apps-api-http.ts` (117 lines) — translates Tauri HTTP client to browser `fetch`
- `tauri-apps-api-shell.ts` (125 lines) — `Command` class with `EventEmitter`, routes to `/api/shell/exec`
- `tauri-apps-api-path.ts` (84 lines) — `join`/`resolve`/`basename`/`dirname`/`extname` polyfills + API calls for `appLocalDataDir`
- `tauri-apps-api-dialog.ts` (98 lines) — uses browser File System Access API (`showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`), `alert()`, `confirm()`
- `tauri-apps-api-window.ts` (156 lines) — `WebviewWindow` class (uses `window.open`), `AppWindow` class (sets `document.title`), geometry classes (`LogicalSize`, `PhysicalSize`, etc.)
- `tauri-apps-api-tauri.ts` (32 lines) — `invoke` shim routing to `/api/compat/invoke` (will be removed separately in Item 16)
- `tauri-apps-api.ts` (14 lines) — `getCurrent()` throws + event stubs (needed for `isInTauri()` detection)

**Trivially-empty no-op shims (consolidate into one file):**
- `tauri-apps-api-app.ts` (13 lines) — `getName()` → `'Rivet (Hosted)'`, `getVersion()` → `'hosted'`, `getTauriVersion()` → `'0.0.0'`
- `tauri-apps-api-globalShortcut.ts` (18 lines) — `register`/`unregister`/`unregisterAll`/`isRegistered` all no-ops
- `tauri-apps-api-process.ts` (11 lines) — `relaunch()` → `window.location.reload()`, `exit()` → no-op
- `tauri-apps-api-updater.ts` (33 lines) — `checkUpdate()` → `{ shouldUpdate: false }`, `installUpdate`/`onUpdaterEvent` no-ops + type exports

**Changes:**
- Merge the 4 no-op shim files above into a single `wrapper/web/shims/tauri-noop-shims.ts`.
- Each Vite alias currently maps a `@tauri-apps/api/*` package to a specific shim file. The aliases for `app`, `globalShortcut`, `process`, `updater` should be updated to point at `tauri-noop-shims.ts`. Since each alias resolves to a different module path but the same file, the no-op shim file must export everything from a single default module — meaning the Vite aliases would need to use named exports. Alternatively, keep 4 one-line re-export files. **Evaluate which approach works better with Vite's alias resolution before implementing.**
- Keep all 8 substantive shims as separate files.

**Impact:** Reduces 4 trivially-empty files (~75 lines total) into 1 file (~40 lines with shared type exports). Small win in file count but improves discoverability — makes it clear which shims have real logic and which are stubs.

---

## 12. DONE - Clean up `useRemoteExecutor.ts` debug logging

**File:** `wrapper/web/overrides/hooks/useRemoteExecutor.ts`

**Bare `console.log` calls that should be removed or converted to `logHostedDebug`:**
- Line 249: `console.log('trying to run tests')` — inside `tryRunTests`, leaks to production console
- Line 313: `console.log(result)` — logs entire test result object to console after successful test run
- Line 315: `console.log(e)` — logs error to console in test catch block (should use `console.error` if kept)
- Line 326: `console.log('Aborting via remote debugger')` — in `tryAbortGraph`
- Line 331: `console.log('Pausing via remote debugger')` — in `tryPauseGraph`
- Line 336: `console.log('Resuming via remote debugger')` — in `tryResumeGraph`

**`logHostedDebug` calls to keep (useful behind debug flag):**
- Lines 213-215: Three `logHostedDebug` calls in `tryRunGraph` logging graph IDs, project graph keys, and mainGraphId — useful for debugging which graph is being executed

**Changes:**
- Delete lines 249, 313, 326, 331, 336 (bare `console.log` calls that serve no purpose in production).
- Change line 315 from `console.log(e)` to `console.error('Test run error:', e)` so errors aren't lost silently.
- Keep lines 213-215 (`logHostedDebug` calls).

**Impact:** Removes 5 stray console.log calls that leak into production. Fixes 1 `console.log(e)` that should be `console.error`.

---

## 13. DONE - Remove unused `updateWorkflowProjectSettings` frontend function and backend route

**Files:**
- `wrapper/web/dashboard/workflowApi.ts`, lines 117-129 — frontend API function
- `wrapper/api/src/routes/workflows.ts`, lines 341-359 — backend `PATCH /projects/settings` route handler

The `updateWorkflowProjectSettings` function in `workflowApi.ts` is exported but never imported or called anywhere in the frontend (verified with grep). It calls `PATCH /api/workflows/projects/settings`.

The corresponding backend route handler at line 341 (`workflowsRouter.patch('/projects/settings', ...)`) is therefore also unreachable — settings are updated exclusively through the publish/unpublish flows (`POST /projects/publish`, `POST /projects/unpublish`), not through a standalone settings update endpoint.

**Changes:**
- Delete `updateWorkflowProjectSettings` from `workflowApi.ts` (lines 117-129, ~13 lines).
- Delete the `PATCH /projects/settings` route handler from `workflows.ts` (lines 341-359, ~19 lines).

**Impact:** Removes ~32 lines of dead code that suggest a settings-update code path that doesn't actually exist.

---

## 14. DONE - Simplify the `normalizeStoredWorkflowProjectSettings` function

**File:** `wrapper/api/src/routes/workflows.ts`, lines 803-841

This function has deeply nested type assertions repeated for every field. For example, the `endpointName` extraction alone is:
```ts
const endpointName = typeof (value as StoredWorkflowProjectSettings | WorkflowProjectSettings | undefined)?.endpointName === 'string'
    ? (value as StoredWorkflowProjectSettings | WorkflowProjectSettings).endpointName
    : defaultSettings.endpointName;
```
This pattern is repeated 5 times (for `endpointName`, `publishedEndpointName`, `publishedSnapshotId`, `publishedStateHash`, `legacyStatus`), with the `publishedSnapshotId` and `publishedStateHash` cases having additional `=== null` branches (lines 811-820).

**Changes:**
- Cast `value` once at the top: `const raw = (value ?? {}) as Record<string, unknown>;`
- Use simple property access for each field:
  ```ts
  const endpointName = typeof raw.endpointName === 'string' ? raw.endpointName : defaults.endpointName;
  const publishedSnapshotId = typeof raw.publishedSnapshotId === 'string' ? raw.publishedSnapshotId
    : raw.publishedSnapshotId === null ? null : defaults.publishedSnapshotId;
  ```
- Keep the legacy status validation (lines 825-832) intact — it guards against invalid values from old settings files.
- This is a readability improvement, not a behavior change.

**Impact:** The function goes from 39 lines of type-assertion gymnastics to ~20 lines of straightforward property checking.

---

## 15. DONE - Fix inconsistent sidecar-path resolution and reduce duplication

**File:** `wrapper/api/src/routes/workflows.ts`

Three handlers manage sidecar files (dataset `.rivet-data` and settings `.wrapper-settings.json`) alongside project files:

1. **PATCH /projects (rename)** — lines 318-328: uses `projectPath.replace(PROJECT_EXTENSION, '.rivet-data')` for datasets and `getWorkflowProjectSettingsPath()` for settings. Then renames both if they exist.
2. **DELETE /projects** — lines 437-445: uses `projectPath.replace(PROJECT_EXTENSION, '.rivet-data')` for datasets and `getWorkflowProjectSettingsPath()` for settings. Then deletes both if they exist.
3. **moveWorkflowProject()** — lines 615-637: uses `projectPath.replace(PROJECT_EXTENSION, '.rivet-data')` for datasets and `getWorkflowProjectSettingsPath()` for settings. Then validates both don't exist at target, then renames both.

**Bug:** The dataset path is computed inconsistently — handlers use `projectPath.replace(PROJECT_EXTENSION, '.rivet-data')` (string replace) while `getWorkflowDatasetPath()` (line 747) is the dedicated helper for exactly this purpose. They produce the same result today but using different approaches is a maintenance risk.

**Changes:**
- Replace all `projectPath.replace(PROJECT_EXTENSION, '.rivet-data')` occurrences (lines 318, 319, 437, 615, 616) with `getWorkflowDatasetPath(projectPath)` for consistency.
- Extract a `getProjectSidecarPaths(projectPath): { dataset: string; settings: string }` helper that returns both paths.
- Use this helper in all three handlers to ensure consistent path resolution.

**Note:** The three handlers perform different operations (rename vs delete vs validate-then-rename), so a single `withSidecars(path, action)` abstraction would over-simplify. The `getProjectSidecarPaths` helper is the right level of abstraction — it eliminates the duplicated path computation while letting each handler keep its specific logic.

**Impact:** Fixes an inconsistency bug and reduces ~15 lines of duplicated path computation.

---

## 16. DONE - Remove the `compat/invoke` router and inline its commands

**Files:**
- `wrapper/api/src/routes/compat.ts` (76 lines) — backend router
- `wrapper/web/shims/tauri-apps-api-tauri.ts` (32 lines) — frontend `invoke` shim
- `wrapper/web/overrides/utils/tauri.ts` — calls `invoke('get_environment_variable', ...)` and `invoke('allow_data_file_scope', ...)`
- `wrapper/web/overrides/model/TauriProjectReferenceLoader.ts` — calls `invoke('read_relative_project_file', ...)`

The compat router (`POST /api/compat/invoke`) is a generic dispatch-by-command-name endpoint mimicking Tauri's `invoke` pattern. It handles 4 commands:

1. **`get_environment_variable`** — called from `getEnvVar()` in `overrides/utils/tauri.ts` line 26. Checks env var name against allowlist, returns value.
2. **`allow_data_file_scope`** — called from `allowDataFileNeighbor()` in `overrides/utils/tauri.ts` line 83. **Already a no-op on the backend** (returns `{ result: null }`), but the frontend still makes the network call.
3. **`read_relative_project_file`** — called from `TauriProjectReferenceLoader.ts` line 18. Reads a file relative to another project file. Used for project reference resolution.
4. **`extract_package_plugin_tarball`** — **Dead code.** No frontend caller exists (verified with grep). The frontend plugin flow (`useLoadPackagePlugin.ts`) uses `/api/plugins/install-package` and `/api/plugins/load-package-main` directly, never calling this command.

The `invoke` shim adds an unnecessary indirection layer: `getEnvVar('OPENAI_API_KEY')` → `invoke('get_environment_variable', { name: 'OPENAI_API_KEY' })` → `fetch('/api/compat/invoke', { body: { command: 'get_environment_variable', args: { name: 'OPENAI_API_KEY' } } })` → switch statement dispatches to handler. This should be a direct API call.

**Changes:**

- **`get_environment_variable`:** Add a direct endpoint `GET /api/config/env/:name` to the existing config router. Update `getEnvVar()` in `overrides/utils/tauri.ts` to call `fetch(\`${API}/config/env/${name}\`)` instead of going through `invoke`. Remove the `import { invoke } from '@tauri-apps/api/tauri'` import.

- **`allow_data_file_scope`:** Make `allowDataFileNeighbor()` in `overrides/utils/tauri.ts` an empty async function that returns immediately. It currently calls `invoke('allow_data_file_scope', ...)` which is already a no-op on the backend — remove the unnecessary network round-trip.

- **`read_relative_project_file`:** Add a direct endpoint `POST /api/native/read-relative` to the native router. Update `TauriProjectReferenceLoader.ts` to call `fetch(\`${API}/native/read-relative\`, ...)` instead of going through `invoke`.

- **`extract_package_plugin_tarball`:** Delete. No caller.

- Delete `compat.ts` entirely.
- Delete `tauri-apps-api-tauri.ts` (the `invoke` shim) — after migrating all callers, no code will import from `@tauri-apps/api/tauri`.
- Remove the `@tauri-apps/api/tauri` alias from `vite.config.ts`.
- Remove the compat router registration from `wrapper/api/src/server.ts`.

**Impact:** Removes an unnecessary abstraction layer (108 lines across 2 files). Frontend code calls purpose-specific endpoints instead of a generic dispatch. Eliminates one shim file entirely.

---

## 17. DONE - Simplify `entry.tsx` process shim

**File:** `wrapper/web/entry.tsx`, lines 1-55

Lines 1-42 define a 42-line `processShim` object with `stdout`, `stderr`, `on`, `off`, `once`, `removeListener`, `nextTick`, `emitWarning`, `exit`, `chdir`, `cwd`, `env`, `argv`, `arch`, `platform`, `version`, `versions`, `browser`, `pid`, `noDeprecation`, `traceDeprecation`, `throwDeprecation`. Lines 44-55 set `globalThis.global` and `globalThis.process`.

**Risk assessment:** Some bundled Node.js libraries (e.g., crypto polyfills, `readable-stream`, event emitters) probe `process.nextTick`, `process.env`, and `process.stdout.write` at import time. Removing these without testing will cause runtime errors that may only manifest in specific code paths (e.g., when a node uses crypto).

**Changes:**

- **Phase 1 (safe):** Remove the properties that are clearly never accessed by any bundled library:
  - `argv`, `arch`, `platform`, `version`, `versions`, `pid` — these are metadata properties never probed by polyfill libraries
  - `noDeprecation`, `traceDeprecation`, `throwDeprecation` — Node.js deprecation handling, irrelevant in browser
  - `exit`, `chdir` — no bundled code calls these

- **Phase 2 (test carefully):** After removing the safe properties, test the full app to verify nothing breaks. If all is well, try removing:
  - `stdout`, `stderr` — keep only if a library writes to these
  - `on`, `off`, `once`, `removeListener` — keep only if a library registers process event listeners

- **Keep regardless:** `env` (accessed by `process.env` checks), `browser` (used by some libraries for environment detection), `cwd` (accessed by path resolution), `nextTick` (needed by stream/event polyfills), `emitWarning` (used by some Node.js built-in modules).

**Impact:** Reduces the shim from 42 lines to ~15 lines (Phase 1) or potentially ~8 lines (Phase 2). The key difference from the previous plan: this acknowledges the risk and recommends incremental reduction with testing, rather than a speculative drop to 1-3 lines.

---

## Summary

| # | Change | Lines removed (est.) | Files affected |
|---|--------|---------------------|----------------|
| 1 | Split workflows.ts | 0 (reorganize) | 1 → 5 |
| 2 | Deduplicate execution handlers | ~40 | 1 |
| 3 | Remove save-shortcut debug logs | ~40 | 2 |
| 4 | Remove useRemoteDebugger debug logs | ~2 | 1 |
| 5 | Simplify Windows keyup workaround | ~45 | 1 |
| 6 | Extract settings modal component | 0 (reorganize) | 1 → 3 |
| 7 | Delete dead api-types.ts | ~104 | 1 |
| 8 | Remove server_old.js | ~103 | 1 |
| 9 | Inline constants.ts | ~3 | 2 |
| 10 | Share workflow types | ~50 | 3 |
| 11 | Consolidate no-op shims | ~35 | 4 → 1 |
| 12 | Clean up useRemoteExecutor logs | ~6 | 1 |
| 13 | Remove unused settings endpoint | ~32 | 2 |
| 14 | Simplify settings normalizer | ~19 | 1 |
| 15 | Fix sidecar path inconsistency | ~15 | 1 |
| 16 | Remove compat router indirection | ~108 | 5 (delete 2, modify 3) |
| 17 | Simplify process shim | ~27 | 1 |

**Estimated net reduction:** ~630 lines of code removed or consolidated, plus significant readability improvements from the reorganizations in items 1 and 6.

## Execution order

Recommended order to minimize merge conflicts and allow incremental validation:

1. **Items 8, 9** — trivial deletions, zero risk
2. **Items 3, 4, 12** — remove debug logging, no behavior change, no risk
3. **Item 7** — delete dead types file
4. **Item 13** — remove unused settings endpoint (both frontend function and backend route)
5. **Item 15** — fix sidecar path inconsistency (small, important correctness fix)
6. **Item 14** — simplify settings normalizer (readability, no behavior change)
7. **Item 2** — deduplicate execution handlers (backend only, test with workflow execution)
8. **Item 17** — simplify process shim (test after each property removal)
9. **Item 11** — consolidate no-op shims (test after — verify Vite alias resolution)
10. **Item 5** — simplify save shortcut (test on both Windows and macOS/Linux)
11. **Item 10** — share types between frontend and backend (touches both sides, test build)
12. **Item 16** — remove compat router (largest behavioral change — creates new endpoints, migrates callers, deletes old ones; test all invoke-dependent features: env var loading, project references, plugin loading)
13. **Item 1** — split workflows.ts (pure reorganization, large diff but no behavior change)
14. **Item 6** — extract settings modal (pure reorganization, verify modal still works)
