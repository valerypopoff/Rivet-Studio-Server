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
4. `open-project` uses the project reference supplied by the workflow tree and opens it through `HostedIOProvider`.
5. In `filesystem` mode that reference is a real server filesystem path. In `managed` mode it is a virtual managed path under `/managed/workflows/...`, even though the shared bridge type still uses the legacy field name `path`.
6. `open-recording` first fetches the serialized recorder payload for the selected `recordingId`, extracts the preferred start graph, and asks the editor to open the virtual path `recording://<recordingId>/replay.rivet-project`.
7. When that virtual path loads, `HostedIOProvider` fetches the replay project and optional replay dataset from the API and imports the dataset snapshot into browser replay state.
8. Replay projects are read-only. A plain save from a replay project throws and the user must use Save As to create a normal project file.
9. `delete-workflow-project` removes the matching open tab inside the editor. If that tab was active, the bridge selects a fallback open project when possible.
10. `workflow-paths-moved` rewrites already-open project references after rename/move so open tabs, loaded-project state, and later saves keep pointing at the new location. In `managed` mode those `fromAbsolutePath` and `toAbsolutePath` fields contain managed virtual project paths rather than host filesystem paths.
11. Folder rename uses that same `workflow-paths-moved` path-rewrite flow for every affected project path under the folder.
12. Project duplication does not use the editor bridge. The dashboard calls `POST /api/workflows/projects/duplicate` directly, refreshes the workflow tree, and intentionally leaves selection and open tabs unchanged.
13. Project uploading also does not use the editor bridge. The dashboard opens a browser file picker, posts the selected file to `POST /api/workflows/projects/upload`, refreshes the workflow tree, and leaves selection and open tabs unchanged.
14. Project downloading also does not use the editor bridge. The dashboard calls `POST /api/workflows/projects/download` directly and only downloads saved server-side project files.
15. Empty-folder deletion is API-only and does not need special bridge cleanup because no workflow project paths move; the dashboard just refreshes the tree after the delete succeeds.
16. On `project-saved`, the dashboard refreshes the workflow tree from the API and trusts the server-derived publication status. It does not locally force a `published -> unpublished_changes` status flip first, and the server now keeps published projects in `published` when the save was a true no-op.
17. On `project-opened`, both sides of the hosted bridge explicitly move focus to the editor iframe so keyboard shortcuts target the editor instead of the workflow-library row that triggered the open.
18. If the iframe reloads, `onLoad` resets `editorReady` to `false`, re-enabling the command buffer until `editor-ready` is sent again.

## Save behavior

Save can be initiated from either context:

- inside the iframe, the editor bridge listens for `Ctrl+S` / `Cmd+S` and calls the editor's normal save flow across platforms, including hosted Windows browser sessions
- outside the iframe, the dashboard captures the save shortcut and sends `save-project`
- in hosted mode, the tracked wrapper override of the upstream save hook emits the `rivet-project-saved` DOM event after a successful save, and the bridge forwards that as `project-saved`
- the hosted wrapper also overrides the upstream Windows hotkey fallback so `Ctrl+S` does not trigger a second save via the legacy keyup path

That lets the hosted shell behave like a single app even though the editor lives in an iframe.

## Copy/Paste behavior

Node copy/paste shortcuts do not cross the editor bridge.

- `Ctrl+C`, `Ctrl+V`, and `Ctrl+D` stay inside the iframe, but hosted builds replace the upstream hotkey hook with a tracked wrapper override so copy/paste reads the latest Jotai state immediately instead of waiting for a React re-render.
- The dashboard does not relay those shortcuts to the iframe. That approach was intentionally avoided because iframe-focused keyboard events are not reliable at the parent-page level.
- In hosted mode, shortcut reliability depends on editor focus, not dashboard focus. The hosted wrapper therefore explicitly focuses the iframe after `project-opened` and reclaims iframe focus on capture-phase pointer interactions inside `.node-canvas`.
- On those canvas interactions, the hosted editor bridge also focuses the canvas element itself unless the click is on a real form control, and blurs stale editor-local text inputs before keyboard node actions run.
- The hosted wrapper also replaces the upstream context-menu hook so closing a context menu clears any focused search input instead of leaving a hidden text field intercepting shortcuts.
- The hosted wrapper keeps the iframe and canvas focusable for keyboard reliability but suppresses their visible browser focus outline, so the editor does not show a white perimeter when focused.
- Save is still special: it crosses the bridge when initiated outside the iframe, but copy/paste/duplicate stay editor-local and iframe-focused save is handled directly inside the editor context.

## Key files

- `wrapper/shared/editor-bridge.ts` - shared message types, guards, and helpers
- `wrapper/shared/workflow-recording-types.ts` - recording IDs and virtual replay path helpers
- `wrapper/web/dashboard/DashboardPage.tsx` - dashboard-side bridge owner
- `wrapper/web/dashboard/EditorMessageBridge.tsx` - editor-side message handling
- `wrapper/web/dashboard/useEditorCommandQueue.ts` - pre-ready command buffering
- `wrapper/web/dashboard/useOpenWorkflowProject.ts` - open/replace-current behavior inside the editor
- `wrapper/web/io/HostedIOProvider.ts` - API-backed project loading/saving plus replay-project loading
- `wrapper/web/overrides/hooks/useCopyNodesHotkeys.ts` - hosted clipboard hotkey override that reads the latest node state synchronously
- `wrapper/web/overrides/hooks/useContextMenu.ts` - hosted context-menu override that clears stale focused menu inputs
- `wrapper/web/overrides/hooks/useSaveProject.ts` - hosted save hook override that dispatches `rivet-project-saved`
- `wrapper/web/overrides/hooks/useWindowsHotkeysFix.tsx` - hosted Windows hotkey override that suppresses duplicate save fallback
- `wrapper/web/hosted-editor.css` - hosted global CSS that suppresses visible canvas focus outlines
- `wrapper/web/vite-aliases.ts` - Vite alias wiring that redirects hosted builds to tracked wrapper overrides
- `rivet/packages/app/src/components/NodeCanvas.tsx` - upstream canvas component that still renders the editor surface and calls the hosted overrides
