# Self-Hosted Rivet Web Wrapper (Reassessed and Hardened)

## What we are building and why
We are building a self-hosted web wrapper around the upstream Rivet repo in `rivet/`.

The objective is to run Rivet through a browser on your VM while keeping practical feature parity with the desktop workflow: project editing, graph execution, plugins, datasets, references, and related tooling.

We are choosing a wrapper architecture instead of maintaining a fork so upstream Rivet can be updated with lower maintenance cost. Desktop-specific dependencies are replaced at the wrapper layer (API shims and hosted services) rather than by long-lived custom changes inside `rivet/`.

## Locked decisions
- `rivet/` is treated as vendor source and will be updated/replaced over time.
- No wrapper-owned custom code is maintained inside `rivet/`.
- Docker Compose deployment.
- Private trusted VM in v1.
- Target is practical full web parity for core Rivet workflows, with explicit handling of unavoidable desktop-only behavior.

---

## Scope and parity definition

### Must work
- Open, edit, run, test, save Rivet projects via browser.
- Browser and Node executor modes.
- Project references loading.
- Dataset operations (CRUD, persistence, import/export).
- Plugin loading, including package plugins.
- Graph revisions (git history) and related UI.
- AI Graph Builder and AI Assist editors (recording output goes to API-backed storage).

### Explicit no-op or web replacement
- Desktop updater UI (`@tauri-apps/api/updater`) -> disabled in hosted mode.
- Window title APIs -> no-op (browser `document.title` fallback acceptable).
- Global shortcuts API -> no-op (already commented out upstream, import still present).
- Tauri Webview window creation -> regular browser `window.open()` behavior.
- Tauri native menus (`onMenuClicked`) -> no-op (wrapper may add browser-based menu later).
- Community login via `WebviewWindow` -> browser popup `window.open()` redirect.
- Tauri shell `open` (URL opening) -> `window.open()` fallback (already handled upstream).

---

## Repository layout
All wrapper-owned code lives outside `rivet/`:
- `wrapper/web` (hosted frontend entry + Vite config + Tauri shims + module overrides)
- `wrapper/api` (compat backend for native/fs/shell/plugin/dataset operations)
- `wrapper/shared` (typed contracts between frontend shims and API backend)
- `ops` (compose, env, scripts, health checks, update checks)
- `docs` (runbook, support matrix, update procedure)

`rivet/` is treated as replaceable vendor source.

---

## Three-state mode detection (critical architectural decision)

Upstream code uses `isInTauri()` from `utils/tauri.ts` to branch behavior. This function checks `window.getCurrent()` from `@tauri-apps/api`. With Tauri shims, this throws and returns `false`, putting the app in "plain browser" mode. But hosted mode is neither desktop-Tauri nor plain-browser:

| Capability                        | Tauri desktop | Plain browser | Hosted mode        |
|-----------------------------------|---------------|---------------|--------------------|
| Server-side file operations       | Yes (Tauri)   | No            | Yes (API backend)  |
| Node executor available           | Yes (sidecar) | No            | Yes (Docker svc)   |
| Native file picker dialogs        | Yes (Tauri)   | Yes (FSA API) | Via API or FSA API |
| Save/load projects by path        | Yes           | No            | Yes (API backend)  |
| Dataset file persistence          | .rivet-data   | IndexedDB     | API-backed storage |
| Env var access                    | Tauri invoke  | process.env   | API backend        |
| Shell commands (git)              | Tauri shell   | No            | API backend        |

The wrapper must override `utils/tauri.ts` to expose:
- `isInTauri()` -> returns `false`
- `isHostedMode()` -> returns `true` (reads `RIVET_HOSTED_MODE` env var injected at build)
- `getEnvVar(name)` -> calls `POST /api/compat/invoke` with `get_environment_variable`
- `allowDataFileNeighbor()` -> calls API backend or no-op (API handles scoping)

Other upstream modules use `isInTauri()` to branch. In hosted mode, the branches must:
- `state/settings.ts`: Show Node executor option (treat hosted like Tauri for this)
- `utils/globals/ioProvider.ts`: Use `HostedIOProvider` (not BrowserIOProvider)
- `useCheckForUpdate.tsx`: Skip update check (same as non-Tauri)
- `useMonitorUpdateStatus.ts`: No-op (same as non-Tauri)
- `useOpenUrl.ts`: Use `window.open()` (same as non-Tauri, already handled)
- `components/OverlayTabs.tsx`: Show community tab regardless (already works)
- `components/ActionBarMoreMenu.tsx`: Show all options regardless

---

## Frontend design (no upstream edits)

### 1. Wrapper entrypoint
`wrapper/web` provides its own `vite.config.ts` that:
- Points to upstream `rivet/packages/app/src/index.tsx` as entry.
- Adds `resolve.alias` entries for all Tauri package shims and module overrides.
- Preserves upstream Vite plugins: `@vitejs/plugin-react`, `vite-tsconfig-paths`, `vite-plugin-svgr`, `vite-plugin-monaco-editor`, `vite-plugin-top-level-await`.
- Adds `define: { 'import.meta.env.VITE_HOSTED_MODE': JSON.stringify('true') }`.
- Excludes `@ironclad/rivet-core` and `@ironclad/trivet` from `optimizeDeps` (matches upstream).
- Resolves `@ironclad/rivet-core` and `@ironclad/trivet` to upstream source paths (matches upstream).

### 2. Required aliases

### 2.1 Tauri package aliases (shim modules)
Alias every `@tauri-apps/api` subpath imported by upstream app to wrapper-owned shim files.

Full list of imported subpaths (verified by grep of `rivet/packages/app/src/`):

| Tauri import                       | Shim behavior                                          | Consumed by                                       |
|------------------------------------|--------------------------------------------------------|---------------------------------------------------|
| `@tauri-apps/api`                  | `window.getCurrent()` throws (no Tauri), rest no-op   | `utils/tauri.ts`, `hooks/useMenuCommands.ts`       |
| `@tauri-apps/api/app`             | `getVersion()` returns `"hosted"` or reads from env    | `UpdateModal.tsx`, `SettingsModal.tsx`, `useWindowTitle.ts` |
| `@tauri-apps/api/dialog`          | `open()`/`save()` -> browser FSA API or API-backed     | `io/TauriIOProvider.ts`                            |
| `@tauri-apps/api/fs`              | All ops -> `POST /api/native/*` calls                  | `TauriNativeApi.ts`, `TauriIOProvider.ts`, `datasets.ts`, `useLoadPackagePlugin.ts`, `useAiGraphBuilder.ts`, `AiAssistEditorBase.tsx` |
| `@tauri-apps/api/globalShortcut`  | `register()`/`unregister()` -> no-op                   | `useGlobalShortcut.ts` (already commented out)     |
| `@tauri-apps/api/http`            | `fetch()` -> browser `fetch()` with interface adapter; `getClient()` returns adapter object. Must translate Tauri response format `{data,status,headers}` to match. `ResponseType.Binary` -> `arrayBuffer()`. | `useLoadPackagePlugin.ts` |
| `@tauri-apps/api/path`            | `appLocalDataDir()` -> `GET /api/path/app-local-data-dir`; `join()` -> path.posix.join polyfill | `useLoadPackagePlugin.ts`, `PluginsOverlay.tsx`, `PluginInfoModal.tsx`, `useAiGraphBuilder.ts` |
| `@tauri-apps/api/process`         | `relaunch()` -> no-op or `window.location.reload()`   | `UpdateModal.tsx`                                  |
| `@tauri-apps/api/shell`           | `Command` class -> calls `POST /api/shell/exec`; `Command.sidecar()` -> no-op; `open(url)` -> `window.open(url)` | `useExecutorSidecar.ts`, `useLoadPackagePlugin.ts`, `ProjectRevisionCalculator.ts`, `useGraphRevisions.ts`, `useOpenUrl.ts` |
| `@tauri-apps/api/tauri`           | `invoke(cmd, args)` -> `POST /api/compat/invoke`      | `utils/tauri.ts`, `TauriProjectReferenceLoader.ts`, `useLoadPackagePlugin.ts` |
| `@tauri-apps/api/updater`         | `checkUpdate()` -> returns `{shouldUpdate:false}`; `installUpdate()`/`onUpdaterEvent()` -> no-op | `UpdateModal.tsx`, `useCheckForUpdate.tsx`, `useMonitorUpdateStatus.ts` |
| `@tauri-apps/api/window`          | `appWindow` -> stub with no-op `setTitle()`; `getCurrent()` -> throws; `WebviewWindow` constructor -> opens browser popup via `window.open()` | `utils/tauri.ts`, `useWindowTitle.ts`, `useMenuCommands.ts`, `NeedsLoginPage.tsx` |

**Critical shim detail: `@tauri-apps/api/http`**
The Tauri HTTP client has a different interface than browser `fetch`. The shim must:
- `fetch(url, options)` -> returns `{ status, data, headers, url, ok }` (Tauri format)
- `getClient()` -> returns object with `get(url, options)` that handles `responseType: ResponseType.Binary` by returning `{ data: Array<number> }` (Tauri returns binary as number array)
- Export `ResponseType` enum: `{ JSON: 1, Text: 2, Binary: 3 }`

**Critical shim detail: `@tauri-apps/api/shell` `Command` class**
The Tauri `Command` class has:
- Constructor: `new Command(program, args, options)` with `{ cwd, encoding }`
- `command.execute()` -> returns `{ code, stdout, stderr }`
- `command.stdout.on('data', cb)` / `command.stderr.on('data', cb)`
- `command.spawn()` -> returns `Child` with `.kill()`
- `Command.sidecar(path)` -> creates a sidecar command

The shim must route `execute()` calls through `POST /api/shell/exec` and return compatible response format. `Command.sidecar()` returns a no-op command that resolves immediately. Streaming stdout/stderr can buffer server-side and return on completion.

### 2.2 Upstream module overrides (mandatory)
The following upstream files must be replaced via Vite `resolve.alias` because they hardcode desktop assumptions that Tauri shims alone cannot fix:

| File (relative to `rivet/packages/app/src/`) | Why alias needed | Override behavior |
|---|---|---|
| `hooks/useGraphExecutor.ts` | Hardcoded `ws://localhost:21889/internal` (line 26) | Use `RIVET_EXECUTOR_WS_URL` env constant |
| `hooks/useRemoteDebugger.ts` | Hardcoded `ws://localhost:21888` default (line 29), hardcoded `ws://localhost:21889/internal` identity check (line 39) | Use `RIVET_REMOTE_DEBUGGER_DEFAULT_WS` and `RIVET_EXECUTOR_WS_URL` env constants for URL defaults and identity comparison |
| `hooks/useRemoteExecutor.ts` | Hardcoded `ws://localhost:21889/internal` in onDisconnect reconnect (line 62) | Use `RIVET_EXECUTOR_WS_URL` env constant |
| `hooks/useExecutorSidecar.ts` | Uses `Command.sidecar()` to launch executor as Tauri child process | Return no-op hook (executor runs as Docker service). Optionally add health-check ping to executor WebSocket. |
| `state/settings.ts` | `executorOptions` gated by `isInTauri()` hides Node executor; `debuggerDefaultUrlState` defaults to `ws://localhost:21888` (line 71) | Show Node executor in hosted mode via `isInTauri() \|\| isHostedMode()`; default debugger URL to `RIVET_REMOTE_DEBUGGER_DEFAULT_WS` |
| `utils/tauri.ts` | `isInTauri()` detection, `getEnvVar()` uses Tauri invoke, `allowDataFileNeighbor()` uses Tauri invoke | Add `isHostedMode()`, route `getEnvVar()` through API backend, make `allowDataFileNeighbor()` call API or no-op |
| `model/native/TauriNativeApi.ts` | All methods call Tauri fs APIs | Replace with `HostedNativeApi` that calls `POST /api/native/*` endpoints |
| `model/TauriProjectReferenceLoader.ts` | Uses Tauri `invoke('read_relative_project_file')` | Replace with API-backed loader calling `POST /api/compat/invoke` |
| `hooks/useLoadPackagePlugin.ts` | Tauri fs/http/path/shell/invoke for NPM package download, tarball extraction, pnpm install sidecar | Replace with API-backed flow: `POST /api/plugins/install-package` (server-side install), `POST /api/plugins/load-package-main` (return plugin entry code) |
| `utils/ProjectRevisionCalculator.ts` | `Command('git', ...)` from Tauri shell | Replace with `POST /api/shell/exec` calls (or shim handles this if Command shim is robust) |
| `hooks/useGraphRevisions.ts` | Uses `Command('git', ...)` from Tauri shell, imports `ProjectRevisionCalculator` | Override if `ProjectRevisionCalculator` is overridden; otherwise Tauri shell shim handles it |
| `utils/globals/ioProvider.ts` | IOProvider selection: falls to `BrowserIOProvider` which cannot do path-based save/load | Select `HostedIOProvider` when `isHostedMode()` returns true |
| `io/TauriIOProvider.ts` | Heavy Tauri dialog/fs usage for open/save | Replace with `HostedIOProvider` (API-backed path operations + optional browser file picker for import/export) |
| `io/datasets.ts` | Tauri fs for `.rivet-data` file save/load alongside `.rivet-project` | Replace with API-backed dataset file persistence |
| `hooks/useLocalExecutor.ts` | Instantiates `TauriNativeApi` and `TauriProjectReferenceLoader` directly (lines 16, 32) | The Vite aliases for `TauriNativeApi` and `TauriProjectReferenceLoader` will automatically redirect these imports. No separate override needed IF aliases are configured as full path aliases. **Verify during Phase A that alias resolution works for transitive imports.** |
| `hooks/useAiGraphBuilder.ts` | Instantiates `TauriNativeApi` (line 22), uses Tauri fs/path for recording logs (lines 18-19, 513-537) | `TauriNativeApi` handled by alias. Tauri fs/path calls for recordings handled by package shims (recordings will go through API or silently skip). |
| `components/community/NeedsLoginPage.tsx` | Creates `WebviewWindow` for OAuth login | `WebviewWindow` shim opens browser popup via `window.open()`. Login redirect flow must work in popup context. |

**Important: transitive import resolution**
Several files (e.g., `useLocalExecutor.ts`, `useAiGraphBuilder.ts`) import modules that are aliased (like `TauriNativeApi`). Vite aliases must be configured as absolute path matches so that both direct and transitive imports resolve to the override. Use the full specifier format in aliases:
```js
resolve: {
  alias: {
    // Module overrides (more specific first)
    '../model/native/TauriNativeApi': '/wrapper/web/overrides/HostedNativeApi',
    // ... etc
  }
}
```
Alternatively, use the `resolve.alias` array format with `find` regex patterns to catch all import paths that resolve to the target file.

### 2.3 Hosted env variables
Injected at build time (Vite `define`) or runtime (read from `/api/config`):
- `RIVET_HOSTED_MODE=true` — enables hosted code paths
- `RIVET_EXECUTOR_WS_URL` — default `ws://<host>/ws/executor/internal` — internal executor WebSocket
- `RIVET_REMOTE_DEBUGGER_DEFAULT_WS` — default `ws://<host>/ws/executor` — remote debugger default
- `RIVET_API_BASE_URL` — default `/api` — API backend base path

Note: `<host>` must resolve correctly for the browser. Use `window.location.host` at runtime, not hardcoded hostnames. The env vars should use relative WebSocket URLs or be computed at runtime:
```js
const wsBase = `ws://${window.location.host}`;
const RIVET_EXECUTOR_WS_URL = `${wsBase}/ws/executor/internal`;
const RIVET_REMOTE_DEBUGGER_DEFAULT_WS = `${wsBase}/ws/executor`;
```

---

## HostedIOProvider (new, required)

The upstream app has three IOProviders:
- `TauriIOProvider` — uses Tauri dialog/fs APIs (desktop)
- `BrowserIOProvider` — uses File System Access API (`showOpenFilePicker`/`showSaveFilePicker`)
- `LegacyBrowserIOProvider` — uses `<input type="file">` fallback

In hosted mode, neither `TauriIOProvider` (no Tauri) nor `BrowserIOProvider` (cannot `saveProjectDataNoPrompt`, `loadProjectDataNoPrompt`, `readPathAsString`, `readPathAsBinary` — all throw "Function not supported") works for server-side project management.

`HostedIOProvider` implements `IOProvider` interface with:
- `saveProjectData()` / `loadProjectData()` -> API-backed: `POST /api/projects/save`, `POST /api/projects/load` (with browser-side project picker UI listing server files)
- `saveProjectDataNoPrompt(project, testData, path)` -> `POST /api/native/write-text` (write to server path)
- `loadProjectDataNoPrompt(path)` -> `POST /api/native/read-text` (read from server path)
- `readPathAsString(path)` / `readPathAsBinary(path)` -> `POST /api/native/read-text` / `POST /api/native/read-binary`
- `saveGraphData()` / `loadGraphData()` -> API-backed or browser FSA API fallback
- `loadRecordingData()` -> API-backed or browser FSA API fallback
- `openDirectory()` -> API-backed directory browser
- `openFilePath()` -> API-backed file browser
- `saveString()` / `readFileAsString()` / `readFileAsBinary()` -> API-backed

Also override `io/datasets.ts` to route `.rivet-data` file operations through API backend instead of Tauri fs.

---

## Hosted dataset persistence strategy

Desktop Rivet persists datasets in two ways:
1. In-memory during session via `BrowserDatasetProvider` (IndexedDB-backed).
2. To `.rivet-data` files alongside `.rivet-project` files via `io/datasets.ts` on save/load.

In hosted mode:
- `BrowserDatasetProvider` (IndexedDB) still works for in-session dataset storage.
- On save: `HostedIOProvider.saveProjectDataNoPrompt()` calls the overridden `datasets.ts` which writes `.rivet-data` to server via API.
- On load: `HostedIOProvider.loadProjectDataNoPrompt()` calls the overridden `datasets.ts` which reads `.rivet-data` from server via API.

This means datasets are persisted server-side alongside project files — same behavior as desktop, just through API instead of Tauri fs.

Required backend endpoints (additions to section below):
- `POST /api/native/exists` — check if file exists (used by `datasets.ts`)

---

## Backend compatibility service (`wrapper/api`)

### 1. Contract style
Use a typed JSON API designed for wrapper shims. Do not attempt to emulate all of Tauri. Emulate only what upstream consumes.

### 2. Required endpoints
- `POST /api/compat/invoke` — dispatch by command name:
  - `get_environment_variable` — allowlist-only env var access
  - `allow_data_file_scope` — no-op or register allowed path
  - `read_relative_project_file` — resolve relative path and read project file
  - `extract_package_plugin_tarball` — extract .tgz to plugin directory
- `POST /api/native/readdir` — list directory contents with options (recursive, globs, ignores)
- `POST /api/native/read-text` — read text file at path
- `POST /api/native/read-binary` — read binary file at path, return base64
- `POST /api/native/write-text` — write text to file at path
- `POST /api/native/write-binary` — write binary (base64 input) to file at path
- `POST /api/native/exists` — check if path exists
- `POST /api/native/mkdir` — create directory (recursive)
- `POST /api/native/remove-dir` — remove directory (recursive, for plugin reinstall)
- `POST /api/shell/exec` — execute allowlisted shell command, return `{code, stdout, stderr}`
- `GET /api/path/app-local-data-dir` — return configured app data directory path
- `GET /api/path/app-log-dir` — return configured log directory path
- `POST /api/plugins/install-package` — server-side NPM package plugin install flow (download tarball, extract, pnpm install)
- `POST /api/plugins/load-package-main` — read installed plugin's main entry file, return content
- `GET /api/projects/list` — list projects in workspace (for hosted file browser UI)
- `POST /api/projects/open-dialog` — return list of .rivet-project files for browser-side picker
- `GET /api/config` — return runtime configuration (WebSocket URLs, hosted mode flag)

### 3. Security and safety constraints
- Filesystem access restricted to:
  - `RIVET_WORKSPACE_ROOT` (project files, references, .rivet-data)
  - `RIVET_APP_DATA_ROOT/plugins` (installed package plugins)
  - `RIVET_APP_DATA_ROOT/logs` (recording logs)
  - Optional configured additional roots
- All path parameters must be normalized and validated against path traversal (no `../` escape).
- `get_environment_variable` must be allowlist-only. Default allowlist:
  - `OPENAI_API_KEY`, `OPENAI_ORG_ID`, `OPENAI_ENDPOINT`
  - Plugin-specific env vars as configured
- Shell execution allowlist:
  - `git` (for revisions)
  - `pnpm` (for plugin dependency install)
  - Optional: `npm`
- Enforce command timeout (default 30s), output size caps (default 10MB), and path normalization checks.
- `extract_package_plugin_tarball` must validate tarball contents don't escape target directory.

---

## Executor service

Run upstream `rivet/packages/app-executor` as dedicated Docker service.

### Entry point
`rivet/packages/app-executor/bin/executor.mts` — starts a WebSocket debugger server on configurable port (default 21889, via `--port` flag).

### Important details
- The executor is one WebSocket server. `/ws/executor` and `/ws/executor/internal` are reverse-proxy path variants to the same backend on port 21889.
- Frontend logic uses URL identity to classify internal-vs-remote behavior. The `isInternalExecutor` flag in `remoteDebuggerState` is set by comparing the connection URL against the internal executor URL constant. Wrapper overrides must compare against `RIVET_EXECUTOR_WS_URL`, not hardcoded localhost.
- In `useRemoteDebugger.ts` line 39: `isInternalExecutor: url === 'ws://localhost:21889/internal'` — override must use `isInternalExecutor: url === RIVET_EXECUTOR_WS_URL`.

### Shared storage
- Plugin installation location must be shared between `api` and `executor` services.
- The executor reads plugins from `getAppDataLocalPath()` which resolves to `~/.local/share/com.ironcladapp.rivet/` on Linux.
- In Docker, mount the shared volume at this path (or set `HOME` env var to control `homedir()` output so `getAppDataLocalPath()` resolves to the mounted path).
- The `api` service installs plugins to `RIVET_APP_DATA_ROOT/plugins/` — this must map to the same location as `<executor-data-dir>/plugins/`.

### Docker volume mapping
```
# Executor container
volumes:
  - rivet_data:/root/.local/share/com.ironcladapp.rivet

# API container (RIVET_APP_DATA_ROOT=/data/rivet-app)
volumes:
  - rivet_data:/data/rivet-app
```
With a symlink or env configuration so both services see `plugins/` in the same location. Simplest approach: set `RIVET_APP_DATA_ROOT=/root/.local/share/com.ironcladapp.rivet` in the API container and mount the same volume.

---

## Docker Compose topology

### Services
- `proxy` — nginx/caddy reverse proxy
- `web` — static file server for built wrapper frontend
- `api` — Node.js backend compatibility service
- `executor` — upstream app-executor WebSocket server

### Routing
- `/` -> `web` (static assets)
- `/api/*` -> `api` (HTTP JSON API)
- `/ws/executor` -> `executor:21889` with WebSocket upgrade
- `/ws/executor/internal` -> `executor:21889` with WebSocket upgrade (same backend)

### Volumes
- `rivet_workspace` — mounted to `RIVET_WORKSPACE_ROOT` in `api` (project files, references, .rivet-data)
- `rivet_data` — mounted to both `api` and `executor` (plugin cache, runtime files, logs)

### Health checks
- `web`: HTTP GET `/` returns 200
- `api`: HTTP GET `/api/config` returns 200
- `executor`: TCP connect to port 21889

---

## Build and dependency model (critical)

### 1. Toolchain pinning
- Node 20.x required (upstream `volta.node: "20.4.0"`).
- Yarn version: root `package.json` declares `"packageManager": "yarn@4.6.0"` (Corepack reads this). Note: `volta.yarn` says `"3.5.0"` and app `package.json` says `"packageManager": "yarn@3.5.0"` — these are stale. The **root `packageManager` field takes precedence** for Corepack. Use Yarn 4.6.0.
- Enable Corepack in Docker: `corepack enable && corepack prepare`.

### 2. Build order
The upstream monorepo build order (from root `package.json` `build` script):
1. `@ironclad/rivet-core` (TypeScript library)
2. `@ironclad/rivet-node` (Node.js integration)
3. `@ironclad/rivet-app-executor` (executor binary, depends on core + node)
4. `@ironclad/trivet` (test runner)
5. `@ironclad/rivet-app` (Vite frontend, depends on core + trivet)
6. `@ironclad/rivet-cli` (CLI, not needed for hosted)

Wrapper build pipeline:
1. Install upstream dependencies: `cd rivet && yarn install`
2. Build upstream core + node + executor + trivet: `cd rivet && yarn workspace @ironclad/rivet-core run build && yarn workspace @ironclad/rivet-node run build && yarn workspace @ironclad/rivet-app-executor run build && yarn workspace @ironclad/trivet run build`
3. (Do NOT build upstream app — wrapper builds its own frontend)
4. Install wrapper dependencies: `cd wrapper && yarn install` (or npm)
5. Build wrapper frontend: `cd wrapper/web && vite build` (uses upstream source via aliases)
6. Build wrapper API: `cd wrapper/api && tsc` (or esbuild bundle)

### 3. Update-safe integration
Wrapper references upstream via path imports and Vite aliases only.
No wrapper-specific generated artifacts or custom patches are maintained inside `rivet/`.

### 4. Upstream Vite config parity
The wrapper `vite.config.ts` must replicate critical settings from `rivet/packages/app/vite.config.ts`:
- `optimizeDeps.exclude: ['@ironclad/rivet-core', '@ironclad/trivet']`
- `resolve.preserveSymlinks: true`
- `resolve.alias` for `@ironclad/rivet-core` -> `../rivet/packages/core/src/index.ts`
- `resolve.alias` for `@ironclad/trivet` -> `../rivet/packages/trivet/src/index.ts`
- All upstream plugins: react, tsconfig-paths, svgr, monaco-editor, top-level-await, splitVendorChunkPlugin
- `build.chunkSizeWarningLimit: 10000`
- `worker.format: 'es'`
- `manualChunks` for `gpt-tokenizer`

---

## Plugin parity strategy

### 1. Problem fixed
Desktop plugin loading (`useLoadPackagePlugin.ts`) relies on:
- `@tauri-apps/api/path` (`appLocalDataDir`, `join`) — for plugin directory paths
- `@tauri-apps/api/fs` (`readDir`, `exists`, `readTextFile`, `writeBinaryFile`, `createDir`, `removeDir`, `writeTextFile`) — for plugin file operations
- `@tauri-apps/api/http` (`fetch`, `getClient`, `ResponseType`) — for NPM registry access and tarball download
- `@tauri-apps/api/tauri` (`invoke`) — for tarball extraction
- `@tauri-apps/api/shell` (`Command.sidecar`) — for pnpm dependency install

Browser cannot do any of this directly.

### 2. Hosted implementation
- **Install**: `POST /api/plugins/install-package` with `{ package, tag }`:
  1. Server checks if plugin already installed and up-to-date (same logic as upstream)
  2. Downloads tarball from NPM registry
  3. Extracts to `RIVET_APP_DATA_ROOT/plugins/<package>-<tag>/package/`
  4. Runs `pnpm install --prod --ignore-scripts` in plugin directory
  5. Writes `.install_complete_version` marker
  6. Returns `{ success: true, log: string }` or error
- **Load**: `POST /api/plugins/load-package-main` with `{ package, tag }`:
  1. Reads `package.json` from installed plugin directory
  2. Reads the `main` entry file
  3. Returns file contents as string
  4. Frontend converts to base64 data URL and dynamic-imports (same as upstream)
- **Executor load**: Executor reads plugins from shared disk at `<data-dir>/plugins/<package>-<tag>/package/` using Node.js `import()` — same as current upstream executor code.

### 3. Failure behavior
- If install/load fails, UI surfaces explicit plugin error with backend error payload.
- Built-in plugins continue to work independently.
- Server returns structured error with install log for debugging.

---

## Implementation phases

### Phase A: bootstrap
1. ✅ **DONE** — Create wrapper folder structure: `wrapper/web`, `wrapper/api`, `wrapper/shared`, `ops`.
2. ✅ **DONE** — Create wrapper Vite config referencing upstream app entry with all required alias entries.
3. ✅ **DONE** — Implement Tauri package shims (all 12 subpaths from section 2.1).
4. ✅ **DONE** — Override `utils/tauri.ts` with hosted mode detection and API-backed `getEnvVar()`.
5. ✅ **DONE** — Override `utils/globals/ioProvider.ts` to select `HostedIOProvider`.
6. ✅ **DONE** — Create stub `HostedIOProvider` (initially delegates to `BrowserIOProvider` for basic testing).
7. ✅ **DONE** — Override `state/settings.ts` to show Node executor and fix debugger default URL.
8. ✅ **DONE** — Override `hooks/useExecutorSidecar.ts` with no-op hook.
9. ✅ **DONE** — Add basic compose stack with proxy, web (dev server), api (stub), executor.
10. **Verification gate**: `vite build` succeeds, app loads in browser without runtime Tauri errors.

### Phase B: execution
1. ✅ **DONE** — Deploy executor service (upstream `app-executor` in Docker, port 21889).
2. ✅ **DONE** — Configure proxy WebSocket routing for `/ws/executor*`.
3. ✅ **DONE** — Override `hooks/useGraphExecutor.ts` with env-driven URL constants.
4. ✅ **DONE** — Override `hooks/useRemoteDebugger.ts` with env-driven URL defaults and identity checks.
5. ✅ **DONE** — Override `hooks/useRemoteExecutor.ts` with env-driven URL in onDisconnect reconnect.
6. **Verification gate**: Select Node executor, run a simple graph, verify run/pause/resume/abort work. Verify Browser executor still works for simple graphs (no fs access needed).

### Phase C: native/fs/reference parity
1. ✅ **DONE** — Implement API backend: `/api/native/*` endpoints (readdir, read-text, read-binary, write-text, write-binary, exists, mkdir, remove-dir).
2. ✅ **DONE** — Implement `HostedNativeApi` (override for `TauriNativeApi`) calling API endpoints.
3. ✅ **DONE** — Implement API-backed `TauriProjectReferenceLoader` override.
4. ✅ **DONE** — Implement `POST /api/compat/invoke` for `get_environment_variable`, `allow_data_file_scope`, `read_relative_project_file`.
5. ✅ **DONE** — Implement full `HostedIOProvider` with API-backed save/load/browse.
6. ✅ **DONE** — Override `io/datasets.ts` to use API-backed file operations for `.rivet-data` persistence.
7. **Verification gate**: Open project from server workspace, edit, save, reopen. Load project references. Dataset CRUD + persistence across save/reload. Browser executor runs graphs that use ReadFile/WriteFile nodes.

### Phase D: plugin parity
1. ✅ **DONE** — Implement `POST /api/plugins/install-package` and `POST /api/plugins/load-package-main`.
2. ✅ **DONE** — Override `hooks/useLoadPackagePlugin.ts` with API-backed install + load flow.
3. ✅ **DONE** — Configure shared plugin volume between `api` and `executor` containers.
4. ✅ **DONE** — Implement `POST /api/compat/invoke` for `extract_package_plugin_tarball`.
5. **Verification gate**: Install a package plugin from NPM. Plugin appears in UI. Run graph using plugin in both Browser and Node executor modes.

### Phase E: revisions, AI features, and hardening
1. ✅ **DONE** — Implement `POST /api/shell/exec` with allowlist enforcement.
2. ✅ **DONE** — Override `utils/ProjectRevisionCalculator.ts` and `hooks/useGraphRevisions.ts` (Tauri shell `Command` shim handles `git` commands correctly via API — `ProjectRevisionCalculator` uses `Command` from shell shim which routes through `POST /api/shell/exec`).
3. ✅ **DONE** — Verify `useAiGraphBuilder.ts` works with aliased `TauriNativeApi` (recording logs go through fs shim to API — TauriNativeApi alias + fs shim cover this).
4. ✅ **DONE** — Verify `NeedsLoginPage.tsx` community login works with `WebviewWindow` shim (browser popup — WebviewWindow shim opens `window.open()`).
5. ✅ **DONE** — Add compatibility scanner (`ops/update-check`).
6. ✅ **DONE** — Add operational runbook (`docs/README.md`).
7. **Verification gate**: Git revision history shows in UI. AI graph builder works. Compatibility scanner passes.

---

## Compatibility scanner (update-gate)
`ops/update-check` must fail if any of these conditions occur after replacing `rivet/`:
1. New `@tauri-apps/api/*` import subpath appears that has no corresponding shim file.
2. Any aliased upstream file path (from section 2.2) no longer exists.
3. Hardcoded localhost WebSocket strings (`ws://localhost:21888`, `ws://localhost:21889`) reappear in active code paths.
4. New direct instantiation of `TauriNativeApi`, `TauriProjectReferenceLoader`, or `TauriIOProvider` appears in files not covered by aliases.
5. Wrapper web `vite build` fails.
6. Integration smoke suite fails.

Implementation: AST grep or regex scan of `rivet/packages/app/src/` after update.

---

## Testing and acceptance

### 1. Unit tests
- Each Tauri shim module: verify exported API matches upstream Tauri types.
- `@tauri-apps/api/http` shim: verify response format translation (Tauri `{data,status}` ↔ browser fetch).
- `@tauri-apps/api/shell` `Command` shim: verify `execute()` returns `{code,stdout,stderr}`.
- API path/shell/env allowlist guards: verify path traversal blocked, unauthorized commands rejected, unauthorized env vars rejected.
- Plugin install/load helpers: verify tarball download, extraction, dependency install, main file read.

### 2. Integration tests
- Open/save `.rivet-project` from server workspace.
- Save triggers `.rivet-data` file creation alongside project file.
- Run graph in Browser executor mode (uses HostedNativeApi for fs).
- Run graph in Node executor mode (uses executor service via WebSocket).
- Project reference loading from server workspace.
- Dataset CRUD: create, add rows, query, export, reimport after project save/load.
- Plugin install from NPM, load in UI, use in graph execution (both executor modes).
- Graph revision list on git-backed workspace via API shell exec.
- AI Graph Builder creates nodes and runs (recording logs saved or gracefully skipped).

### 3. E2E tests
- Full workflow: open -> edit -> run -> save -> reopen -> verify state preserved.
- Executor disconnect/reconnect behavior (kill executor container, verify reconnect).
- Negative cases: denied path traversal, unauthorized shell command, plugin install failure, executor outage with graceful error.
- Multi-tab: two browser tabs with same project (verify no corruption).

### Acceptance criteria
- Hosted UI loads and works without Tauri runtime — no console errors from missing Tauri APIs.
- Node executor works behind reverse proxy WebSocket endpoints.
- Browser executor works with API-backed NativeApi.
- Projects and datasets persist on server filesystem.
- Required parity workflows above pass.
- Updating/replacing `rivet/` does not require moving wrapper-owned code into `rivet/`.
- Compatibility scanner passes against current upstream.

---

## Update workflow
1. Replace `rivet/` with newer upstream (git pull or copy).
2. Run `ops/update-check`:
   a. Scan for new Tauri imports.
   b. Verify all aliased paths still exist.
   c. Scan for new hardcoded localhost URLs.
   d. Run `vite build`.
   e. Run smoke tests.
3. If checks fail, update wrapper shims/aliases/overrides only.
4. Re-run checks until all pass.
5. Deploy updated compose stack.

---

## Risk register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Upstream adds new `@tauri-apps/api/*` subpath import | Build failure | Compatibility scanner detects; add new shim |
| Upstream changes `isInTauri()` logic or location | Mode detection breaks | Alias on `utils/tauri.ts`; scanner checks |
| Upstream restructures `packages/app/src/` paths | Aliases break | Scanner verifies all aliased paths exist |
| Upstream changes Tauri API usage patterns (new methods) | Runtime errors | Shim type-checking against upstream Tauri types |
| Upstream upgrades `@tauri-apps/api` major version | Shim interface mismatch | Pin shim types to match upstream's Tauri version |
| Yarn version drift between root and sub-packages | Build failures | Use root `packageManager` field; document in runbook |
| WebSocket proxy misconfiguration | Executor unreachable | Health check on executor; smoke test covers this |
| Plugin volume mount mismatch | Executor can't find plugins | Integration test: install plugin via API, run in executor |

---

## Assumptions
- Single trusted operator in v1.
- Server-side project workspace storage is acceptable.
- Browser IndexedDB is acceptable for in-session dataset cache (server-side persistence via .rivet-data files on save).
- If upstream introduces fundamentally new desktop-only APIs, wrapper will add equivalent hosted adapters or explicitly mark feature unsupported.
- Community features (template sharing) may have reduced functionality in hosted mode if OAuth login flow doesn't work in popup context.
