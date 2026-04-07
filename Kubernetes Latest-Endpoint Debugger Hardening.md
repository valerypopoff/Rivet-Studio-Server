# Kubernetes Latest-Endpoint Debugger Hardening

## Summary

The repo's current Kubernetes shape already answers most of the scale problem:

- the control-plane backend is intentionally a singleton in Helm (`replicaCount.backend=1`, `autoscaling.backend.enabled=false`)
- the execution plane is the part intended to scale horizontally
- `/workflows-latest/*` and `/ws/latest-debugger` are both control-plane routes
- `/workflows/*` is the published-execution route and is intentionally non-debuggable today

That means this iteration does **not** need a distributed debugger transport, cross-replica event fanout, or sticky debugger-session routing.

The implementation target is:

1. prove that the current supported Kubernetes topology keeps latest-endpoint debugging working while execution replicas scale
2. encode and test that contract explicitly, so nobody later scales the backend into unsupported behavior by accident
3. document the debugger support matrix clearly

This plan preserves the current product contract:

- latest endpoint runs are debuggable
- published endpoint runs are not
- backend/control-plane stays singleton
- execution/published plane can scale out

It also makes one important current limitation explicit:

- the latest debugger is still **process-local and not run-scoped**

This pass proves the supported topology. It does **not** redesign debugger isolation across concurrent latest runs.

## Important Public APIs / Interfaces / Types

### External contracts: no behavioral expansion

These remain unchanged:

- `POST ${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}/:endpointName`
- `POST ${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}/:endpointName`
- `POST /internal/workflows/:endpointName`
- `GET /api/config`
- `WS /ws/latest-debugger`

The supported debugger contract remains:

- `/ws/latest-debugger` is latest-only
- published endpoint execution remains non-debuggable
- Kubernetes support for latest debugging requires a single backend/control-plane replica
- `/api/config` advertises `remoteDebuggerDefaultWs` only when the latest debugger is enabled on a control-plane API

### Internal/test-only addition

Add a test seam to reset module-scoped debugger state between tests:

- file: `wrapper/api/src/latestWorkflowRemoteDebugger.ts`
- addition: `resetLatestWorkflowRemoteDebuggerForTests()` or equivalent `__testing` export

Purpose:

- clear the cached `latestWorkflowRemoteDebugger`
- clear the `latestWorkflowRemoteDebuggerUpgradeHandlerInitialized` flag
- close any retained websocket server state before the next test
- keep debugger tests deterministic inside one Node test process

This is internal only and not part of the public runtime contract.

## Current Wiring Findings To Lock In

These are the repo truths the implementation should preserve and explicitly prove:

- `wrapper/api/src/server.ts` initializes the latest debugger only on control-plane profiles.
- `wrapper/api/src/latestWorkflowRemoteDebugger.ts` creates a process-local `startDebuggerServer()` instance bound to the API HTTP server's upgrade path.
- `wrapper/api/src/latestWorkflowRemoteDebugger.ts` also caches module-scoped singleton state, so test ordering matters unless that state is reset.
- `createApiApp(profile)` alone does **not** install the websocket upgrade handler. Tests that want production-real debugger behavior must explicitly call `initializeLatestWorkflowRemoteDebugger(server)` on the HTTP server.
- `wrapper/api/src/routes/workflows/execution.ts` attaches `remoteDebugger` only for latest runs (`enableRemoteDebugger: true`), never for published runs.
- `wrapper/api/src/routes/config.ts` exposes `remoteDebuggerDefaultWs` only when `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER=true`.
- `image/proxy/default.conf.template` routes:
  - `${RIVET_LATEST_WORKFLOWS_BASE_PATH}` -> control-plane API
  - `/ws/latest-debugger` -> control-plane API
  - `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` -> execution API
- the same nginx websocket route must also preserve trusted proxy auth and websocket upgrade headers, or browser-side debugging breaks even if backend code is correct
- `charts/templates/validate-values.yaml` already prevents backend scale-out
- `charts/overlays/prod.yaml` already models the intended topology: one backend replica, multiple execution replicas
- there are currently no direct tests proving the websocket debugger path itself

## Implementation Plan

### 1. Add a dedicated latest-debugger integration test suite

Create:

- `wrapper/api/src/tests/latest-workflow-remote-debugger.test.ts`

This suite should be the authoritative proof that latest-endpoint debugging works in the supported topology.

#### Test harness shape

Use a real HTTP server, not mocked route handlers:

- build app with `createApiApp(profile)`
- wrap with `http.createServer(app)`
- for control/combined tests, call `initializeLatestWorkflowRemoteDebugger(server)` before listening
- use the `ws` client package to connect to `/ws/latest-debugger`
- use `getExpectedProxyAuthToken()` instead of hardcoded auth header values
- drive websocket assertions through real websocket client events:
  - success path: `open`, `message`, `close`
  - failure path: `unexpected-response`, `error`
- add small helpers for:
  - opening a debugger websocket
  - waiting for a bounded set of messages
  - asserting that no debugger event arrives within a timeout
  - closing websocket clients and the HTTP server cleanly so the test runner does not hang on open handles
- keep the suite serial because it mutates `process.env` and module-scoped debugger state

#### Environment setup

Per test or suite fixture:

- temp `RIVET_WORKFLOWS_ROOT`
- temp `RIVET_APP_DATA_ROOT`
- `RIVET_STORAGE_MODE=filesystem`
- `RIVET_KEY=<known test key>`
- `RIVET_REQUIRE_WORKFLOW_KEY=false` unless a specific auth case is being tested
- toggle `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER` per case
- call the new reset helper in both `beforeEach` and `afterEach`

#### Workflow fixture strategy

Do not hand-roll fake debugger events.

Provision a real latest-executable workflow by reusing the same real workflow machinery already exercised in `workflow-services.test.ts`:

- create a real project fixture with a trivial graph that produces a successful output quickly
- publish it through the existing publication path so it becomes discoverable by endpoint name
- use the real latest endpoint HTTP route to execute it

Default choice:

- reuse the trivial workflow fixture patterns already present in `workflow-services.test.ts`
- use real publish helpers rather than manually writing publication sidecars unless there is already a tiny helper available

#### Required test cases

Add these exact cases:

1. `latest debugger receives events for latest endpoint execution`
- profile: `combined` or `control`
- debugger enabled
- websocket connects successfully with trusted proxy header
- POST latest endpoint
- assert websocket receives at least `start` and `done`

2. `published endpoint execution does not emit latest debugger events`
- profile: `combined`
- debugger enabled
- websocket connects successfully with trusted proxy header
- POST published endpoint
- assert the published run succeeds
- assert no debugger event arrives within a bounded timeout

3. `latest debugger websocket rejects untrusted upgrades`
- profile: `combined` or `control`
- debugger enabled
- connect without trusted proxy header
- assert websocket upgrade fails with unauthorized behavior through `unexpected-response` or socket error

4. `latest debugger websocket is unavailable when disabled`
- profile: `combined` or `control`
- debugger disabled
- connect with trusted proxy header
- assert websocket upgrade fails with a `404`-style unavailable response

5. `execution-only profile does not provide latest debugger`
- profile: `execution`
- even if the env flag is true, no control-plane debugger should be available there
- assert `/ws/latest-debugger` is not usable there

6. `api config advertises latest debugger websocket only when supported`
- combined/control with debugger enabled: `/api/config` returns non-empty `remoteDebuggerDefaultWs`
- combined/control with debugger disabled: `/api/config` returns `remoteDebuggerDefaultWs: ''`
- execution profile: `/api/config` stays unavailable because config is a control-plane route

Optional but recommended if low-cost:

7. `multiple debugger clients on the single backend all observe latest runs`
- this locks the current process-local broadcast semantics explicitly instead of leaving them implicit

### 2. Add the debugger-state reset seam

Modify:

- `wrapper/api/src/latestWorkflowRemoteDebugger.ts`

Add a test-only reset function and keep production behavior unchanged.

Required behavior:

- clear the cached debugger instance
- clear the upgrade-handler-initialized marker
- if a websocket server exists, close it safely before reset
- document via comment that the helper exists only because the module uses process-local singleton state

Do not redesign the runtime model in this iteration.
This is not a distributed-debugger project.

### 3. Tighten static contract tests around Kubernetes routing and singleton control-plane behavior

Update:

- `wrapper/api/src/tests/phase4-static-contract.test.ts`
- expand `wrapper/api/src/tests/api-profile.test.ts` if that is the better place for `/api/config` exposure and debugger-default assertions

Add or expand assertions so the static contract explicitly proves the debugger topology.

Required assertions:

1. Proxy template routes and websocket headers
- `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` -> `$execution_upstream`
- `${RIVET_LATEST_WORKFLOWS_BASE_PATH}` -> `$api_upstream`
- `/ws/latest-debugger` -> `$api_latest_debugger_upstream`
- `/ws/latest-debugger` forwards `X-Rivet-Proxy-Auth`
- `/ws/latest-debugger` forwards `Upgrade` and `Connection`

2. Chart singleton guardrails
- `validate-values.yaml` fails if `replicaCount.backend != 1`
- `validate-values.yaml` fails if `autoscaling.backend.enabled=true`

3. Overlay support shape
- `charts/overlays/prod.yaml` keeps `backend: 1`
- `charts/overlays/prod.yaml` allows scaled execution replicas (`execution > 1`)
- backend autoscaling remains disabled there

This static layer is the proof that "many replicas" means many **execution** replicas, while latest/debugger traffic still stays on the singleton control-plane backend.

### 4. Sharpen Helm validation messaging so the debugger contract is obvious

Update:

- `charts/templates/validate-values.yaml`

Keep the existing guardrails, but make the failure text explicitly mention the current reason.

Current message is too generic:

- "remaining process-local backend paths"

Replace it with wording that names the debugger/latest-run reason directly, for example:

- backend must remain singleton because latest-workflow execution and `/ws/latest-debugger` are still process-local control-plane features

This is a clarity change, not a behavior change.

### 5. Update docs to reflect the supported Kubernetes debugger topology

Update at minimum:

- `docs/access-and-routing.md`
- `docs/architecture.md`

Recommended additional update if there is a suitable deployment section:

- `docs/development.md`

#### Required doc content

Add an explicit supported-topology statement:

- latest debugger support in Kubernetes assumes one backend/control-plane replica
- execution-plane replicas may scale independently
- latest endpoint runs remain debuggable under that topology
- published endpoint runs remain non-debuggable
- manually scaling the backend outside Helm guardrails is unsupported for latest debugging
- the current latest debugger is process-local and not a distributed cross-replica debugger

In `docs/access-and-routing.md`:

- extend the "Latest debugger model" section with a "Kubernetes support note"
- mention that `/ws/latest-debugger` depends on the trusted proxy path and singleton control-plane routing

In `docs/architecture.md`:

- extend the runtime shape / compatibility discussion to state that control-plane singleton is intentional, not accidental
- state that execution scaling is the supported horizontal scale boundary for endpoint runs

In `docs/development.md` if updated:

- note that repo-local Docker and local direct-process mode do not prove multi-backend debugger support, because the supported contract is backend singleton plus scalable execution

## Test Cases And Scenarios

### Backend / integration

Run targeted tests after implementation:

```bash
npx tsx --test \
  wrapper/api/src/tests/latest-workflow-remote-debugger.test.ts \
  wrapper/api/src/tests/api-profile.test.ts \
  wrapper/api/src/tests/phase4-static-contract.test.ts \
  wrapper/api/src/tests/workflow-services.test.ts
```

### Full backend signoff

Run:

```bash
npm --prefix wrapper/api run build
npm --prefix wrapper/api test
```

### What must be explicitly proven

The final implementation must prove these scenarios:

- websocket upgrade to `/ws/latest-debugger` succeeds only on control-plane/combined API with debugger enabled
- websocket upgrade fails cleanly for untrusted requests
- latest endpoint execution emits debugger events
- published endpoint execution does not emit latest debugger events
- `/api/config` advertises a debugger websocket only when the feature is enabled on a control-plane API
- control-plane singleton plus execution scale-out is the documented and enforced Kubernetes support shape
- proxy routing keeps latest/debugger on control-plane and published execution on execution-plane
- proxy routing preserves the trusted proxy auth and websocket upgrade headers needed for debugger traffic
- Helm validation prevents backend scale-out from silently breaking the debugger contract

## Rollout / Monitoring

No rollout migration is required because there is no external contract expansion.

Operational outcome after this change:

- the repo will explicitly document that latest debugger support is tied to backend singleton
- tests will detect regressions if someone later changes routing or Helm values in a way that breaks that assumption
- execution scaling remains supported and proven independently from the debugger path

## Explicit Assumptions And Defaults

- latest debugger support remains latest-only
- published endpoint execution remains non-debuggable
- Kubernetes support target is:
  - backend/control-plane: `1`
  - execution-plane: scalable
- no distributed debugger broker, session routing token, or cross-replica event fanout will be implemented in this iteration
- no debugger session isolation redesign will be implemented in this iteration; the current latest debugger remains process-local and not run-scoped
- the existing Helm chart remains the source of truth for supported Kubernetes topology
- if someone manually scales the backend outside Helm guardrails, latest debugger behavior is unsupported and does not need to be fixed in this scope
