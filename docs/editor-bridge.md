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
| `workflow-paths-moved` | `moves[]` | A project or folder rename/move changed one or more absolute project paths |

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
4. `open-project` uses an absolute server path from the workflow tree and opens it through `HostedIOProvider`.
5. `open-recording` first fetches the serialized recorder payload for the selected `recordingId`, extracts the preferred start graph, and asks the editor to open the virtual path `recording://<recordingId>/replay.rivet-project`.
6. When that virtual path loads, `HostedIOProvider` fetches the replay project and optional replay dataset from the API and imports the dataset snapshot into browser replay state.
7. Replay projects are read-only. A plain save from a replay project throws and the user must use Save As to create a normal project file.
8. `delete-workflow-project` removes the matching open tab inside the editor. If that tab was active, the bridge selects a fallback open project when possible.
9. `workflow-paths-moved` rewrites already-open project paths after rename/move so open tabs, loaded-project state, and later saves keep pointing at the new location.
10. Project duplication does not use the editor bridge. The dashboard calls `POST /api/workflows/projects/duplicate` directly, refreshes the workflow tree, and intentionally leaves selection and open tabs unchanged.
11. Project uploading also does not use the editor bridge. The dashboard opens a browser file picker, posts the selected file to `POST /api/workflows/projects/upload`, refreshes the workflow tree, and leaves selection and open tabs unchanged.
12. Project downloading also does not use the editor bridge. The dashboard calls `POST /api/workflows/projects/download` directly and only downloads saved server-side project files.
13. On `project-saved`, the dashboard optimistically marks published workflows as `unpublished_changes` for the saved path and then refreshes the workflow tree from the API.
14. If the iframe reloads, `onLoad` resets `editorReady` to `false`, re-enabling the command buffer until `editor-ready` is sent again.

## Save behavior

Save can be initiated from either context:

- inside the iframe, the editor bridge listens for `Ctrl+S` / `Cmd+S` and calls the editor's normal save flow across platforms, including hosted Windows browser sessions
- outside the iframe, the dashboard captures the save shortcut and sends `save-project`

That lets the hosted shell behave like a single app even though the editor lives in an iframe.

## Copy/Paste behavior

Node copy/paste shortcuts do not cross the editor bridge.

- `Ctrl+C`, `Ctrl+V`, and `Ctrl+D` are handled entirely inside the iframe by the upstream editor-side hotkey logic.
- The dashboard does not relay those shortcuts to the iframe. That approach was intentionally avoided because iframe-focused keyboard events are not reliable at the parent-page level.
- In hosted mode, shortcut reliability depends on editor focus, not dashboard focus. The hosted wrapper therefore makes the node canvas focusable and shifts focus back to it on normal canvas/node interactions.
- The editor also clears focus from temporary editor-local inputs such as context-menu search when those surfaces close, so keyboard node actions are not accidentally blocked by a hidden or stale focused input.
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
- `rivet/packages/app/src/hooks/useCopyNodesHotkeys.ts` - editor-local node copy/paste/duplicate hotkeys
- `rivet/packages/app/src/components/NodeCanvas.tsx` - hosted canvas focus handoff for keyboard node actions
- `rivet/packages/app/src/hooks/useContextMenu.ts` - editor context-menu close behavior that clears stale focused search inputs
