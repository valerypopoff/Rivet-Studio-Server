# Editor Bridge

The dashboard and the Rivet editor run in separate browsing contexts. The dashboard is the outer page; the editor loads inside an `<iframe>` pointed at `/?editor`. They communicate through `window.postMessage`.

## Contract

All message types live in `wrapper/shared/editor-bridge.ts`. Both sides import from the same file so the contract cannot drift.

### Dashboard-to-editor commands

| Type | Payload | When sent |
|---|---|---|
| `open-project` | `path`, `replaceCurrent` | User clicks a project in the sidebar or creates a new project |
| `save-project` | (none) | User presses Ctrl+S outside the iframe or clicks a save action |
| `delete-workflow-project` | `path` | User confirms project deletion in settings modal |
| `workflow-paths-moved` | `moves[]` | A rename or move operation changed one or more project paths on disk |

### Editor-to-dashboard events

| Type | Payload | When sent |
|---|---|---|
| `editor-ready` | (none) | Editor iframe has mounted and is ready to receive commands |
| `project-opened` | `path` | Editor successfully loaded a project file |
| `project-open-failed` | `path`, `error` | Editor failed to load a project (missing file, parse error, etc.) |
| `active-project-path-changed` | `path` | User switched between open project tabs inside the editor |
| `open-project-count-changed` | `count` | Number of open project tabs changed |
| `project-saved` | `path`, `didChangePersistedState` | Project was saved to disk; the boolean reports whether the save changed persisted `.rivet-project` or `.rivet-data` contents |

## Message flow

1. Dashboard renders the iframe. The editor emits `editor-ready` once mounted.
2. Any commands sent before `editor-ready` are buffered by `useEditorCommandQueue` and flushed when the editor signals readiness.
3. The dashboard validates incoming messages with `isEditorToDashboardEvent()` and checks origin with `isValidBridgeOrigin()`. The editor does the same for its direction with `isDashboardToEditorCommand()`.
4. On `project-saved`, the dashboard may optimistically update the workflow status for the saved project before the next tree refresh, but only when `didChangePersistedState` is `true`.
5. If the iframe reloads (e.g. navigation), `onLoad` resets `editorReady` to `false`, re-enabling the buffer until the editor sends `editor-ready` again.

## Key files

- `wrapper/shared/editor-bridge.ts` - shared types, type guards, and send helpers
- `wrapper/web/dashboard/DashboardPage.tsx` - dashboard side: receives events, sends commands
- `wrapper/web/dashboard/EditorMessageBridge.tsx` - editor side: receives commands, sends events
- `wrapper/web/dashboard/useEditorCommandQueue.ts` - pending-command buffering hook
