# Workflow Dashboard Implementation Plan

## Goal

Turn the current hosted app from a pure Rivet editor into a thin workflow-management dashboard with an integrated editor.

Target user experience:

- a persistent vertical panel on the left titled `Folders`
- ability to create folders with a `+` action
- right-click menu on each folder with:
  - `Rename folder`
  - `Add rivet project to the folder`
- each folder contains Rivet project entries
- clicking a Rivet project opens it in the editor in the main content area
- all folders and `.rivet-project` files are stored on the host machine under a dedicated `workflows/` directory
- a separate host-side server can later expose those saved workflows as endpoints

## Product intent

The editor should remain the core authoring surface, but it should live inside a lightweight management shell.

That shell should:

- make the hosted app feel like a workflow workspace, not just a file-open dialog around the editor
- give a stable home for workflow organization and future features such as publishing, endpoint metadata, run history, status, tags, and ownership
- treat the host `workflows/` directory as the source of truth for persisted workflow assets

## Current relevant architecture

### Frontend

- `wrapper/web/entry.tsx` boots the upstream Rivet app directly
- current project open/save behavior flows through `wrapper/web/io/HostedIOProvider.ts`
- `HostedIOProvider` currently uses prompts and generic API calls for project paths
- there is no wrapper-owned dashboard shell yet
- the current experience is editor-first, not library-first

### Backend

- `wrapper/api/src/server.ts` mounts wrapper-owned API routes
- `wrapper/api/src/routes/native.ts` already supports path-based read/write/readdir operations
- `wrapper/api/src/routes/projects.ts` currently offers coarse project listing, but not a folder/project tree model
- `wrapper/api/src/security.ts` currently validates paths against allowed roots, but it does not define a dedicated workflow-library root abstraction

### Storage

- today, project loading/saving is path-oriented and generic
- the new dashboard needs a dedicated storage contract for:
  - listing folders
  - creating folders
  - renaming folders
  - listing projects within folders
  - creating projects inside folders
  - opening projects by logical identity

## Non-regression constraints from past failures

The dashboard work must explicitly avoid reintroducing issues that were already fixed in the hosted wrapper.

### 1) Preserve the browser-safe boot path

- Do not bypass `wrapper/web/entry.tsx`.
- The dashboard shell should be introduced as wrapper-owned UI around the existing upstream app boot path, not as a second independently bootstrapped application.
- Do not introduce new imports that pull Node-oriented runtime code into the browser bundle.
- Any new dependencies used by the dashboard shell must be browser-safe under the current Vite build.

Reason:

- previous wrapper failures included `process is not defined`, `Buffer is not defined`, and Node-oriented package resolution leaking into the browser app.

### 2) Do not disturb Vite root/output assumptions or Monaco worker wiring

- Do not redesign the build so the dashboard requires a second Vite root or a separate output tree.
- Keep the current Monaco worker output assumptions intact.
- Do not change `wrapper/web/vite.config.ts` output behavior unless a concrete dashboard requirement truly demands it.
- If the shell introduces new lazy-loaded assets, verify they do not interfere with Monaco worker asset paths.

Reason:

- Monaco previously broke because the worker asset ended up missing from the served output and the browser got `index.html` instead.

### 3) Preserve hosted executor and remote-debugger wiring exactly

- The dashboard shell must not own or replace executor-selection logic.
- It must not introduce an alternate websocket lifecycle or a second executor/debugger connection manager.
- `useGraphExecutor.ts`, `useRemoteDebugger.ts`, and `useRemoteExecutor.ts` should remain the authoritative execution path.
- The dashboard feature should treat editor execution behavior as an existing subsystem and integrate with it, not restructure it.

Reason:

- past regressions included the Run button disappearing in Node mode, stale remote-debugger state, and Browser mode accidentally routing to remote execution.

### 4) Preserve the hosted browser-vs-node executor split

- The dashboard must not reintroduce any logic based on transient remote connection state when deciding which executor is active.
- Opening a project from the sidebar must not implicitly force Node execution mode.
- Project-management UI state must remain separate from the execution-mode selection state.

Reason:

- a previous hosted regression came from upstream-style logic where remote websocket activity could cause Browser runs to use the remote executor.

### 5) Keep the existing authoritative project-open and save path

- The sidebar must reuse the same underlying project deserialize/load/save path as the current hosted editor.
- Do not create a second project-loading codepath that manually reconstructs editor state.
- Do not make the dashboard mutate graph/editor atoms directly as a substitute for proper project-open behavior.

Reason:

- earlier problems around unsaved projects and graph presence in `project.graphs` were subtle and easy to break by splitting state ownership.

### 6) Do not couple dashboard work to executor bundle patching

- The workflow dashboard should not require changes to `ops/bundle-executor.cjs` unless there is a direct execution-related need.
- Project-library features should be implemented in wrapper frontend/API layers, not by adding unrelated logic to executor patching.

Reason:

- executor patching is intentionally narrow and already fragile enough that it now fails fast when upstream snippets drift.

### 7) Preserve the vendor boundary

- Implement dashboard behavior in `wrapper/` and `ops/` only.
- Do not modify vendored upstream source under `rivet/` for workflow-library UI or host storage behavior.
- If an upstream component must be wrapped, do it through wrapper-owned composition, aliases, or overrides.

Reason:

- this repo is intentionally structured as a wrapper rather than a fork, and previous fixes were designed around that boundary.

## Recommended high-level design

## 1) Introduce a dedicated workflow library root - DONE

Create one explicit server-side workflow root instead of relying on arbitrary workspace paths.

Recommended rule:

- define `RIVET_WORKFLOWS_ROOT`
- default it to a host-backed path mounted into the API and web/executor environment as needed
- for local Docker development, bind that path to a repo-local folder such as `./workflows`
- inside containers, expose it as a stable path such as `/workflows`

Why this matters:

- enforces that dashboard-managed content lives in one place
- makes the future endpoint-exposing host service simpler
- reduces accidental coupling to the broader workspace tree
- lets the dashboard use stable relative identifiers instead of arbitrary absolute paths

Recommended file layout:

```text
workflows/
  Folder A/
    my-project.rivet-project
    my-project.rivet-data
  Folder B/
    subflow.rivet-project
```

Initial scope recommendation:

- support one level of user-managed folders under `workflows/`
- support Rivet project files directly inside those folders
- do not support nested folders initially unless there is a clear need

This keeps the UX simple and matches the requested sidebar mental model.

## 2) Add a workflow-library API instead of overloading generic native routes - DONE

Create a wrapper-owned route group such as:

- `wrapper/api/src/routes/workflows.ts`

Recommended endpoints:

### Library tree

- `GET /api/workflows/tree`
  - returns folders and contained project items
  - response should be logical metadata, not raw filesystem details only

Example response shape:

```json
{
  "folders": [
    {
      "id": "folder-a",
      "name": "Folder A",
      "relativePath": "Folder A",
      "projects": [
        {
          "id": "folder-a/my-project.rivet-project",
          "name": "my-project",
          "fileName": "my-project.rivet-project",
          "relativePath": "Folder A/my-project.rivet-project",
          "updatedAt": "2026-03-07T00:00:00.000Z"
        }
      ]
    }
  ]
}
```

### Folder operations

- `POST /api/workflows/folders`
  - body: `{ name }`
  - creates a folder under `RIVET_WORKFLOWS_ROOT`

- `PATCH /api/workflows/folders`
  - body: `{ relativePath, newName }`
  - renames a folder

### Project operations

- `POST /api/workflows/projects`
  - body: `{ folderRelativePath, name, template? }`
  - creates a new `.rivet-project` file in a folder
  - optional template can seed metadata/title/graph skeleton

- `GET /api/workflows/projects/content?path=Folder%20A/my-project.rivet-project`
  - returns raw serialized project data or wrapper-normalized project payload

- optional later:
  - `PATCH /api/workflows/projects/rename`
  - `DELETE /api/workflows/projects`
  - `POST /api/workflows/projects/move`

Why a separate API is better than reusing `/api/native/*` directly:

- lets the frontend work in terms of folders and projects instead of raw paths
- centralizes naming rules and validation
- makes the future endpoint server integration easier
- reduces the chance that UI code starts depending on generic unrestricted file operations

## 3) Add a workflow-root abstraction in API security/config - DONE

Extend `wrapper/api/src/security.ts` with a workflow-specific accessor.

Recommended additions:

- `getWorkflowsRoot()`
- ensure it resolves from `RIVET_WORKFLOWS_ROOT`
- validate all workflow API operations against that root
- sanitize names to prevent path traversal and illegal filesystem names

Rules to enforce:

- no `..`
- no path separators inside folder names when creating/renaming
- only `.rivet-project` project files are managed by the dashboard
- folder rename should remain within the workflow root only

This is one of the most important implementation details because the dashboard will be intentionally exposing filesystem-backed management actions.

## 4) Introduce a wrapper-owned dashboard shell around the upstream editor - DONE

The app should stop booting directly into the raw upstream editor canvas.

Important constraint:

- this means introducing a wrapper-owned shell around the existing app surface, not replacing the existing browser boot path or splitting the app into multiple independently booted React trees.

Recommended frontend structure:

- create a wrapper-owned shell component such as:
  - `wrapper/web/dashboard/WorkflowDashboardShell.tsx`
- keep the upstream editor mounted as the main content area inside that shell
- the shell owns the left navigation panel and workflow selection state

Recommended visual layout:

```text
+-----------------------------------------------------------+
| Left sidebar              | Main editor area              |
|---------------------------|-------------------------------|
| Folders                +  | Selected Rivet editor         |
|                           |                               |
| Folder A                  |                               |
|   my-project              |                               |
|   another-project         |                               |
| Folder B                  |                               |
|   subflow                 |                               |
+-----------------------------------------------------------+
```

Recommended responsibilities:

### Sidebar shell owns

- fetch workflow tree
- create folder flow
- folder context menu
- create project flow inside folder
- selected project identity
- refresh after mutations

### Upstream editor area owns

- rendering and editing the currently opened project
- save behavior once project is loaded
- existing graph editing functionality

## 5) Decide how the shell opens a selected project in the existing editor state - DONE

This is the key integration question.

Recommended approach:

- do not fork the upstream editor app
- instead, bridge from the wrapper shell into the existing project-loading state/actions already used by the hosted app

Implementation discovery tasks during build:

- identify the upstream state/action path used after `HostedIOProvider.loadProjectData(...)`
- extract or expose a wrapper-callable `openProjectFromPath(path)` flow
- use the existing deserialize/load path rather than inventing a second project-loading codepath

Preferred long-term shape:

- a wrapper service or hook that can do:
  - `openHostedProject(path: string)`
- it should internally reuse `HostedIOProvider.loadProjectDataNoPrompt(path)` and then dispatch into the same app state update path the current open flow uses
- it should preserve the current saved-path semantics so normal `Save` continues to target the same project file without inventing a dashboard-only save mechanism

Avoid:

- manually mutating many editor atoms from the sidebar
- creating a second non-authoritative project-loading implementation
- duplicating deserialize logic in the dashboard component
- bypassing existing hosted project-open behavior in a way that could reintroduce unsaved-project or `project.graphs` synchronization bugs

## 6) Update HostedIOProvider to cooperate with library-driven paths - DONE

`HostedIOProvider` is currently prompt-driven for project save/load.

Recommended changes:

### Keep

- low-level read/write helpers
- `loadProjectDataNoPrompt(path)`
- `saveProjectDataNoPrompt(project, testData, path)`

### Change

- reduce reliance on prompt-based project selection for normal hosted use
- allow the dashboard shell to be the primary chooser of project path
- preserve fallback prompt-based behavior temporarily for compatibility if needed

Recommended save behavior after a dashboard open:

- once a project is opened from `workflows/...`, subsequent saves should write back to that exact path through `saveProjectDataNoPrompt`
- `Save As` can remain prompt-based initially, but should later become folder-aware inside the dashboard

## 7) Folder and project creation UX - DONE

### Folder creation

When user clicks `+` in the `Folders` panel:

- show a small modal or inline input
- validate non-empty unique name
- call `POST /api/workflows/folders`
- refresh tree and auto-expand/select the new folder

### Folder context menu

On right click of a folder:

- `Rename folder`
- `Add rivet project to the folder`

### Add rivet project to folder

Recommended first version:

- show a modal asking for project name
- server creates a new starter `.rivet-project`
- immediately open it in the editor

Recommended server-side starter project behavior:

- create a valid minimal Rivet project structure
- set title/name from requested project name
- optionally seed a default empty graph so the editor opens cleanly

This is better than asking the browser to upload an arbitrary local file because your requested workflow model is library-first and host-backed.

Optional later enhancement:

- add `Import existing .rivet-project into folder`
- add drag/drop into folder

## 8) Data model choices

Use relative workflow-library paths as stable identifiers in the dashboard layer.

Recommended identifiers:

- folder id: relative folder path
- project id: relative file path

Examples:

- folder id: `Folder A`
- project id: `Folder A/my-project.rivet-project`

Avoid using display names as identifiers.

Recommended UI model:

```ts
interface WorkflowFolderItem {
  id: string;
  name: string;
  relativePath: string;
  projects: WorkflowProjectItem[];
}

interface WorkflowProjectItem {
  id: string;
  name: string;
  fileName: string;
  relativePath: string;
  updatedAt: string;
}
```

## 9) State management plan

Recommended wrapper-owned state:

- workflow tree data
- loading/error state for sidebar operations
- expanded folders
- selected project id/path
- currently opened project path

Recommended location:

- wrapper-owned React context or Jotai atoms under `wrapper/web/`

Do not mix the library-navigation state directly into upstream editor state unless a clear existing extension point already exists.

## 10) Save semantics and editor integration - DONE

To make the dashboard feel coherent, the open project path must remain authoritative.

Recommended rules:

- opening a project from sidebar sets current project file path in the editor state
- normal `Save` writes back to the same path
- new unsaved temporary projects should be avoided when created from sidebar
- folder-created projects should start life already persisted on disk inside `workflows/`

This matters because your host-side endpoint server will depend on stable on-disk artifacts.

## 11) Recommended phased rollout

### Phase 1: backend workflow library foundation - DONE

Deliverables:

- `RIVET_WORKFLOWS_ROOT` config
- workflow root accessor and validation
- `/api/workflows/tree`
- `/api/workflows/folders` create/rename
- `/api/workflows/projects` create
- tests for path safety and naming rules

Outcome:

- backend can manage a real host-backed workflow library safely

### Phase 2: sidebar dashboard shell - DONE

Deliverables:

- wrapper-owned shell layout
- left sidebar with folder/project tree
- create folder action
- folder context menu
- add-project modal
- fetch/refresh logic
- explicit regression check that the app still boots through the current wrapper entrypoint and the Monaco editor still opens successfully inside the dashboard shell

Outcome:

- app visually becomes a workflow dashboard with an embedded editor area

### Phase 3: project open integration - DONE

Deliverables:

- bridge from selected sidebar item to existing editor load flow
- authoritative current-path tracking
- save writes back to workflow file
- regression checks for Browser execution, Node execution, and project switching without breaking the current hosted executor selection rules

Outcome:

- clicking a project opens the real editor for that project in the main area

### Phase 4: polish and hardening

Deliverables:

- loading/empty/error states
- optimistic refresh or invalidation strategy
- rename conflict handling
- unsaved-changes guard before switching projects
- keyboard and context-menu polish

Outcome:

- feature is stable enough for daily workflow management

## 12) Recommended implementation sequence in code

### Backend

1. DONE - Add workflow root config to API security/config.
2. DONE - Add `workflows.ts` router and mount it in `wrapper/api/src/server.ts`.
3. DONE - Implement folder tree listing.
4. DONE - Implement folder create/rename.
5. DONE - Implement project create with minimal starter file generation.

### Frontend

6. DONE - Add wrapper API client for workflow routes.
7. DONE - Add dashboard state and types under `wrapper/web/`.
8. DONE - Build left sidebar tree and context menu.
9. DONE - Wrap the upstream app/editor in a dashboard shell.
10. DONE - Connect project selection to existing hosted project open flow.
11. DONE - Update save behavior to preserve workflow-library paths.

### Ops/config

12. DONE - Mount host `workflows/` directory into the relevant container(s).
13. DONE - Add env vars in Docker Compose and docs.
14. DONE - Document how the host-side endpoint server should consume the same directory.

## 13) Open questions to resolve during implementation

These do not block planning, but they should be settled early:

- Should folders be flat only, or can they nest?
  - recommendation: flat first
- Should project rename be included in v1?
  - recommendation: not required for first vertical slice
- Should delete be included in v1?
  - recommendation: no, avoid destructive actions initially
- Should the dashboard create a blank Rivet project or duplicate from a template?
  - recommendation: blank valid starter project first
- How should unsaved editor changes behave when user clicks another project?
  - recommendation: add a confirmation guard before switching

## 14) Risks and mitigation

### Risk: dashboard duplicates editor project-loading logic

Mitigation:

- reuse hosted IO provider and existing app open flow
- extract one authoritative wrapper-facing open-project action

### Risk: path handling becomes unsafe

Mitigation:

- dedicated workflow root
- strict name sanitization
- no raw arbitrary path writes from sidebar UI

### Risk: save behavior becomes inconsistent

Mitigation:

- store current opened workflow path centrally
- make `Save` path-preserving by default

### Risk: UI shell becomes invasive to upstream updates

Mitigation:

- keep dashboard shell wrapper-owned
- keep upstream editor mounted as-is in main content area
- avoid broad edits inside vendored `rivet/`

## 15) Acceptance criteria

The feature should be considered complete when all of the following are true:

- the app shows a left `Folders` panel by default
- user can create a folder from the UI
- folder is created on disk under the host `workflows/` directory
- user can right-click a folder and rename it
- renamed folder is reflected on disk
- user can right-click a folder and add a Rivet project to it
- the new `.rivet-project` file is created on disk under that folder
- clicking a project in the sidebar opens it in the main editor area
- saving in the editor writes back to the same file in `workflows/`
- switching projects does not silently discard unsaved edits
- the wrapper still boots without reintroducing browser-bundle runtime errors such as missing `process`/`Buffer`
- opening a Code node still works, including Monaco worker loading
- Browser executor still runs locally when Browser mode is selected
- Node executor still keeps the Run button available for a healthy websocket connection and still surfaces sidecar-style logs in the browser console
- the design remains wrapper-owned and does not require modifying vendored upstream code for the dashboard behavior

## 16) Recommended first implementation slice

If implementation starts immediately, the best first slice is:

- add `RIVET_WORKFLOWS_ROOT`
- implement `/api/workflows/tree`
- implement folder create and project create endpoints
- render the left sidebar with real data
- wire project click to open existing `.rivet-project` files

That slice gets you the core product shift quickly:

- from "editor with prompts"
- to "workflow dashboard with integrated editor"
