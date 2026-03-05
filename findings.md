# Findings: Self-hosted Rivet Wiring

This file captures critical wiring findings from getting the wrapper + Docker stack running reliably.

## 1) App behavior that controls execution buttons

- Run button visibility is controlled in `rivet/packages/app/src/components/ActionBar.tsx`:
  - `canRun = (remoteDebugger.started && !remoteDebugger.reconnecting) || selectedExecutor === 'browser'`
- Implication:
  - Browser mode can always run.
  - Node mode requires a healthy remote debugger WebSocket connection.

## 2) Critical hosted override behavior

### `useGraphExecutor` selection must follow user mode exactly

- Bad logic (from upstream pattern):
  - `remoteExecutor.active || selectedExecutor === 'nodejs' ? remoteExecutor : localExecutor`
- Why this breaks hosted mode:
  - Once WS has ever connected, `remoteExecutor.active` can keep routing runs to remote executor.
  - Browser mode then incorrectly runs remotely.
- Correct hosted logic:
  - `selectedExecutor === 'nodejs' ? remoteExecutor : localExecutor`

## 3) WebSocket routing requirements (Docker + nginx)

### Frontend URLs

- Hosted URLs should be proxy-based, not direct container ports:
  - Internal executor WS: `/ws/executor/internal`
  - Debugger WS: `/ws/executor`
- Build from `window.location` (`ws://` vs `wss://`) in `wrapper/shared/hosted-env.ts`.

### nginx path rewrite is required

- nginx must rewrite paths when proxying:
  - `/ws/executor/internal` -> `http://executor:21889/internal`
  - `/ws/executor` -> `http://executor:21889/`
- If not rewritten, executor receives wrong path and WS fails silently/reconnects.

### Executor must bind to Docker network interface

- Upstream debugger server defaults to host `localhost`.
- In containerized deployment, this blocks other containers (nginx) from connecting.
- Must bind to `0.0.0.0` for Docker networking.
- We patch this in Docker bundle step (without editing upstream files directly).

## 4) Vite alias/override matching gotcha

- Vite `resolve.alias` regex matches the **raw import specifier string**, not resolved file paths.
- Patterns like `.*\/hooks\/useGraphExecutor` do **not** catch sibling imports like `./useGraphExecutor`.
- Use relative-import-aware patterns like:
  - `^\.\.?\/(?:.*\/)?useGraphExecutor(\.js|\.ts)?$`
- For generic names (`settings`, `datasets`, etc.), keep patterns restricted to relative imports to avoid accidental package matches.

## 5) Override file path depth gotcha

- Nested override files can easily use wrong `../../..` depth.
- Example fixed issue:
  - `overrides/utils/globals/ioProvider.ts` needed 5 `..` segments to reach repo root imports from `rivet/...`.
- Symptom: Vite build fails with unresolved `../../...` imports from override files.

## 6) Executor image build findings

- Upstream `app-executor` build script runs `pkg` + `rustc`-related steps intended for native sidecar artifacts.
- This is unnecessary in Docker runtime for web wrapper and caused `spawn rustc ENOENT`.
- Stable Docker approach:
  - Build `rivet-core` and `rivet-node`.
  - Bundle executor entry with esbuild only.
  - Run generated JS bundle with Node in container.

## 7) Practical validation checklist after any wiring changes

1. `docker compose ... build web executor`
2. `docker compose ... up -d`
3. Confirm logs:
   - executor: `Node.js executor started on port 21889.`
4. Browser mode:
   - run a 1-node graph; verify no executor errors.
5. Node mode:
   - switch to Node executor, ensure Run button is visible.
   - verify WS connection uses `/ws/executor/internal` via proxy.
6. If Run button disappears in Node mode:
   - check WS connection state first (ActionBar `canRun` condition).

## 8) Non-negotiable project rule

- Do not modify vendor upstream source under `rivet/` for wrapper-specific behavior.
- Keep all hosted adaptations in `wrapper/` and `ops/`.
