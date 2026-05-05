# Editor Bridge

The dashboard and the Rivet editor run in separate browsing contexts:

- the dashboard is the top-level page at `/`
- the editor loads inside an `<iframe>` pointed at `/?editor`

They communicate through `window.postMessage`.

## Contract

All message types live in `wrapper/shared/editor-bridge.ts`. Both sides import from the same file so the contract cannot drift.

### Dashboard-to-editor commands

| Type | Payload | When sent |
|---|---|---|
| `open-project` | `path`, `replaceCurrent` | User opens or creates a workflow project |
| `open-recording` | `recordingId`, `replaceCurrent` | User opens a stored workflow run from the recordings browser |
| `save-project` | (none) | User saves from the dashboard surface or presses the save shortcut outside the iframe |
| `delete-workflow-project` | `path` | User deletes a workflow project from the dashboard |
| `workflow-paths-moved` | `moves[]` | A project or folder rename/move changed one or more workflow project references |

### Editor-to-dashboard events

| Type | Payload | When sent |
|---|---|---|
| `editor-ready` | (none) | Editor iframe mounted and is ready to receive commands |
| `project-opened` | `path` | A project or replay opened successfully |
| `project-open-failed` | `path`, `error` | Open failed for a project path or recording ID |
| `active-project-path-changed` | `path` | User switched the active tab inside the editor |
| `open-project-count-changed` | `count` | Number of open editor tabs changed |
| `project-saved` | `path` | Current project saved successfully |

## Message flow

1. The dashboard renders the iframe. The editor emits `editor-ready` once mounted.
2. Commands sent before `editor-ready` are buffered by `useEditorCommandQueue` and flushed once the editor is ready.
3. Both sides validate message shape and origin before acting.
4. Project and recording open commands are serialized inside the editor iframe so overlapping async loads cannot leave the active replay project and loaded recorder from different runs.
5. `open-project` uses the project reference supplied by the workflow tree, loads the snapshot through `HostedIOProvider`, then opens or replaces it through Rivet's `RivetWorkspaceHost`. The wrapper keeps only the hosted path lookup, duplicate-id guard, stale-empty-tab cleanup, and replace-current confirmation around that upstream workspace handle. The opened-project sync also preserves an empty tab strip across reloads: it must not recreate a pathless `projectState` as a tab, and it normalizes stale persisted tab metadata by dropping missing entries, orphan metadata, duplicate project ids, legacy full-project payloads, and pathless entries with no active project or snapshot. When damaged duplicate entries share an id, it keeps the file-backed one.
6. In `filesystem` mode that reference is a real server filesystem path. In `managed` mode it is a virtual managed path under `/managed/workflows/...`, even though the shared bridge type still uses the legacy field name `path`.
7. Hosted editor project tabs show only the project title. The wrapper strips upstream's bracketed file-name suffix from `ProjectSelector` at build time because the workflow tree already owns the file/path context and this repo does not commit changes inside the vendored `rivet/` tree.
8. `open-recording` first fetches the serialized recorder payload for the selected `recordingId`, extracts the preferred start graph, and asks the editor to open the virtual path `recording://<recordingId>/replay.rivet-project`.
9. When that virtual path loads, `HostedIOProvider` fetches the replay project and optional replay dataset from the API and imports the dataset snapshot into browser replay state.
10. The bridge caches the loaded recorder by virtual replay path and restores or clears `loadedRecordingState` when the active tab path changes, because Rivet's loaded-recording state is global while the hosted workspace can keep multiple recording tabs open. Whenever a recorder is attached, the bridge forces Rivet's live `selectedExecutorState` to `browser`; changing only the default executor is not enough in current Rivet because `useGraphExecutor` routes clicks through the live selected executor. If a replay tab is restored after an iframe/page reload, the bridge derives the recording ID from the virtual path, refetches the serialized recorder, and restores browser replay mode for that tab instead of treating it as a normal runnable project.
11. Replay projects are read-only. A plain save from a replay project throws and the user must use Save As to create a normal project file.
12. `delete-workflow-project` resolves the hosted path to the current open project id, then calls `RivetWorkspaceHost.closeProject()`. If that tab was active, upstream Rivet owns the fallback-tab load and can fail safely without dropping the current tab.
13. `workflow-paths-moved` rewrites wrapper revision/session caches and then calls `RivetWorkspaceHost.moveProjectPaths()` so open tabs, loaded-project state, and later saves keep pointing at the new location. In `managed` mode those `fromAbsolutePath` and `toAbsolutePath` fields contain managed virtual project paths rather than host filesystem paths.
14. Folder rename uses that same `workflow-paths-moved` path-rewrite flow for every affected project path under the folder.
15. Project duplication does not use the editor bridge. The dashboard calls `POST /api/workflows/projects/duplicate` directly, refreshes the workflow tree, and intentionally leaves selection and open tabs unchanged.
16. Project uploading also does not use the editor bridge. The dashboard opens a browser file picker, posts the selected file to `POST /api/workflows/projects/upload`, refreshes the workflow tree, and leaves selection and open tabs unchanged.
17. Project downloading also does not use the editor bridge. The dashboard calls `POST /api/workflows/projects/download` directly and only downloads saved server-side project files.
18. Empty-folder deletion is API-only and does not need special bridge cleanup because no workflow project paths move; the dashboard just refreshes the tree after the delete succeeds.
19. On `project-saved`, the hosted editor first reconciles the active project metadata and tab label back to the saved file-tree name without reloading the project, then the dashboard refreshes the workflow tree from the API and trusts the server-derived publication status. It does not locally force a `published -> unpublished_changes` status flip first, and the server now keeps published projects in `published` when the save was a true no-op.
20. On `project-opened`, both sides of the hosted bridge explicitly move focus to the editor iframe so keyboard shortcuts target the editor instead of the workflow-library row that triggered the open.
21. If the iframe reloads, `onLoad` resets `editorReady` to `false`, re-enabling the command buffer until `editor-ready` is sent again.

## Save behavior

Save can be initiated from either context:

- inside the iframe, the editor bridge listens for `Ctrl+S` / `Cmd+S` and calls the editor's normal save flow across platforms, including hosted Windows browser sessions
- outside the iframe, the dashboard captures the save shortcut and sends `save-project`
- save completion is reported through `RivetAppHost.onProjectSaved`, which the wrapper forwards to the dashboard as `project-saved`; the wrapper does not override upstream save/menu hooks just to observe saves
- the API validates the saved project payload before persistence and treats the workflow tree/file name as the hosted project title source of truth; if the editor changed `data.metadata.title`, the saved `.rivet-project` is rewritten back to the current tree name
- after a successful save, the hosted wrapper patches only project-title metadata in the active project, opened-project tab registry, and any cached opened-project snapshot so the visible tab updates to the file-tree name immediately without reopening the project or changing the active graph
- the hosted wrapper also overrides the upstream Windows hotkey fallback so `Ctrl+S` does not trigger a second save via the legacy keyup path

That lets the hosted shell behave like a single app even though the editor lives in an iframe.

## Copy/Paste behavior

Node copy/paste shortcuts do not cross the editor bridge.

- `Ctrl+C`, `Ctrl+X`, `Ctrl+V`, and `Ctrl+D` stay inside the iframe, but hosted builds replace the upstream hotkey hook with a tracked wrapper override so copy/cut/paste reads the latest Jotai state immediately instead of waiting for a React re-render.
- The dashboard does not relay those shortcuts to the iframe. That approach was intentionally avoided because iframe-focused keyboard events are not reliable at the parent-page level.
- In hosted mode, shortcut reliability depends on editor focus, not dashboard focus. The hosted wrapper therefore explicitly focuses the iframe after `project-opened` and reclaims iframe focus on capture-phase pointer interactions inside `.node-canvas`.
- On those canvas interactions, the hosted editor bridge also focuses the canvas element itself unless the click is on a real form control, and blurs stale editor-local text inputs before keyboard node actions run.
- The hosted wrapper also replaces the upstream context-menu hook so closing a context menu clears any focused search input instead of leaving a hidden text field intercepting shortcuts.
- The hosted wrapper keeps the iframe and canvas focusable for keyboard reliability but suppresses their visible browser focus outline, so the editor does not show a white perimeter when focused.
- Save is still special: it crosses the bridge when initiated outside the iframe, but copy/cut/paste/duplicate stay editor-local and iframe-focused save is handled directly inside the editor context.

## Adjacent hosted execution transport

The editor bridge is not the same thing as the executor/debugger websocket transport. In the Rivet 2.0 integration, the hosted shell mounts the editor through `RivetAppHost` and passes the hosted executor websocket as `executor.internalExecutorUrl`.

- the editor-side bridge remains in `wrapper/web/dashboard/EditorMessageBridge.tsx`; executor UI classification stays in upstream Rivet's `useExecutorSession` / `useRemoteDebugger` flow through `executor.internalExecutorUrl`
- executor transport ownership stays in upstream Rivet app code (`useExecutorSession`, `useRemoteDebugger`, `useRemoteExecutor`, and the shared executor-session runtime); the wrapper passes the hosted executor URL and does not alias those transport/debugger hooks
- hosted wrapper code still owns project-open/delete/path-move messages, parent-page save relay, and hosted IO adapters; upstream Rivet owns workspace transitions, tab close fallback, path moves, and the actual save transition
- hosted provider wiring is explicit in `hostedRivetProviders`: the wrapper passes `HostedIOProvider`, the shared browser dataset provider, hosted environment lookup, and hosted path-policy reads into `RivetAppHost.providers`
- stale wrapper transport override files were removed after the Rivet 2 seam migration; do not restore `useExecutorSession`, `useRemoteDebugger`, `useGraphExecutor`, or `useRemoteExecutor` aliases unless the upstream seam is removed

Those execution websocket responsibilities are separate from the dashboard/editor `window.postMessage` bridge. The bridge moves open/save/delete/path-move intent between browsing contexts; the Rivet executor session talks to `/ws/executor*`.

## Key files

- `wrapper/shared/editor-bridge.ts` - shared message types, guards, and helpers
- `wrapper/shared/workflow-recording-types.ts` - recording IDs and virtual replay path helpers
- `wrapper/web/dashboard/DashboardPage.tsx` - dashboard composition root that wires the bridge, sidebar, and editor iframe together
- `wrapper/web/dashboard/useEditorBridgeEvents.ts` - dashboard-side message listeners and outer-page save shortcut capture
- `wrapper/web/dashboard/useEditorCommandQueue.ts` - pre-ready command buffering
- `wrapper/web/dashboard/editorBridgeFocus.ts` - iframe/canvas focus helpers and save-shortcut detection
- `wrapper/web/dashboard/EditorMessageBridge.tsx` - editor-side message handling
- `wrapper/web/dashboard/HostedEditorApp.tsx` - `RivetAppHost` callback forwarding for active project, open project count, and saved project events
- `wrapper/web/dashboard/useReconcileHostedProjectTitleAfterSave.ts` - save-completion title reconciliation for active project metadata, tab labels, and opened-project snapshots
- `wrapper/web/dashboard/hostedRivetProviders.ts` - explicit provider overrides passed into `RivetAppHost`
- `wrapper/web/dashboard/useOpenWorkflowProject.ts` - hosted path loading, duplicate-id checks, and open/replace-current calls into `RivetWorkspaceHost`
- `wrapper/web/io/HostedIOProvider.ts` - API-backed project loading/saving plus replay-project loading
- `wrapper/web/overrides/hooks/useCopyNodesHotkeys.ts` - hosted clipboard hotkey override that reads the latest node state synchronously
- `wrapper/web/overrides/hooks/useContextMenu.ts` - hosted context-menu override that clears stale focused menu inputs
- `wrapper/web/overrides/hooks/useWindowsHotkeysFix.tsx` - hosted Windows hotkey override that suppresses duplicate save fallback
- `wrapper/web/hosted-editor.css` - hosted global CSS that suppresses visible canvas focus outlines
- `wrapper/web/vite.config.ts` - hosted build plugins, including the scoped `ProjectSelector` tab-label normalization
- `wrapper/web/vite-aliases.ts` - Vite alias wiring that redirects hosted builds to tracked wrapper overrides
- `rivet/packages/app/src/host.tsx` - upstream Rivet 2.0 host seam that provides the editor providers, storage bootstrap, and external executor URL wiring
