# Plan to Fix Node Executor Mode and Restore Dual Browser/Node Execution

## Purpose
This document outlines the recommended plan to fix the hosted Rivet wrapper so that both Browser and Node executor modes work reliably.

The immediate blocker is that switching to Node executor mode causes the Run button to disappear. Based on the current code and the findings already documented, the most likely root cause is not the wrapper architecture itself, but the current hosted implementation of remote-debugger state.

## Implementation status

- DONE: restored atom-backed hosted remote-debugger state ownership in `wrapper/web/overrides/hooks/useRemoteDebugger.ts`
- DONE: restored truthful handling for `isInternalExecutor`, `remoteUploadAllowed`, `reconnecting`, `started`, and lifecycle callbacks in the hosted debugger override
- DONE: performed a static audit of the main consumers (`ActionBar`, `ActionBarMoreMenu`, `DebuggerConnectPanel`, `useRemoteExecutor`, `useGraphExecutor`)
- DONE: unblocked wrapper web vendored-workspace dependency resolution in `wrapper/web/vite.config.ts`, `wrapper/web/package.json`, `wrapper/web/index.html`, and `wrapper/web/entry.tsx`
- DONE: installed the additional wrapper web dependencies needed to bundle vendored upstream app/core/trivet source
- DONE: wrapper web build validation now passes via `npm run build`

---

## Executive summary

### Current best root-cause hypothesis
The hosted override for `useRemoteDebugger` no longer preserves the upstream state contract that the rest of the Rivet app expects.

Upstream behavior depends on `useRemoteDebugger` being the authoritative owner of a reactive `remoteDebuggerState` object that accurately tracks:

- `socket`
- `started`
- `reconnecting`
- `url`
- `remoteUploadAllowed`
- `isInternalExecutor`

The current hosted override instead uses a module-level singleton socket and returns a synthesized state object on render. That object is not backed by the upstream `remoteDebuggerState` atom and does not preserve the original semantics.

This is likely causing desynchronization between:

- the selected executor mode
- actual socket lifecycle
- ActionBar button visibility
- upload capability
- other consumers such as debugger UI and remote execution flows

### Architectural conclusion
The wrapper architecture is still valid.

The most likely failure is at the implementation level in the hosted `useRemoteDebugger` override and possibly in how that override interacts with alias resolution and hook lifecycle.

---

## Key facts already established

### 1. Run button visibility logic
The Run button is controlled by `rivet/packages/app/src/components/ActionBar.tsx`:

- `canRun = (remoteDebugger.started && !remoteDebugger.reconnecting) || selectedExecutor === 'browser'`

Implications:

- Browser mode should always be runnable
- Node mode depends on correct remote-debugger state

### 2. Browser executor routing fix appears correct
The hosted `useGraphExecutor` override correctly changed executor selection to:

- `selectedExecutor === 'nodejs' ? remoteExecutor : localExecutor`

This fixed a real bug where Browser mode could be incorrectly routed to remote execution after past WebSocket activity.

### 3. Infra fixes were necessary and should be kept
The following were good fixes and should remain in place:

- hosted WebSocket URLs derived from `window.location`
- nginx WebSocket proxying
- nginx path rewrite for executor endpoints
- executor binding to `0.0.0.0` in Docker

### 4. The current hosted `useRemoteDebugger` override is suspicious
The override currently returns:

- `started: selectedExecutor === 'nodejs'`
- `reconnecting: false`
- `remoteUploadAllowed: true`
- `isInternalExecutor: selectedExecutor === 'nodejs'`

These values are not derived from authoritative remote-debugger state transitions and do not match upstream semantics.

---

## Primary objective
Restore correct remote-debugger state semantics in hosted mode without abandoning the wrapper architecture.

---

## Secondary objective
After remote-debugger state is repaired, validate and then fix the remaining Node-mode graph-upload issue if it still exists.

---

## Non-goals

The following should not be treated as primary redesign goals unless the investigation disproves the current architecture:

- moving wrapper code into `rivet/`
- replacing the wrapper approach with a long-lived fork
- rewriting all execution logic from scratch
- disabling either Browser or Node execution mode

---

## Overall approach

The work should happen in two layers:

### Layer 1: restore state correctness
Repair hosted `useRemoteDebugger` so that it preserves the upstream contract and becomes the authoritative source of remote-debugger UI state again.

### Layer 2: validate actual execution behavior
Once state is correct, re-run the Node executor scenarios and verify whether the remaining issues are:

- fully resolved
- purely graph-upload related
- or still affected by a separate lifecycle or aliasing bug

---

# Phase 1: restore the upstream `useRemoteDebugger` contract

## Goal
Make hosted `useRemoteDebugger` behave like upstream in terms of state ownership and lifecycle, while still using hosted URLs and any hosted-specific socket implementation details.

## Files to inspect and modify

Primary:

- `wrapper/web/overrides/hooks/useRemoteDebugger.ts`

Reference behavior:

- `rivet/packages/app/src/hooks/useRemoteDebugger.ts`
- `rivet/packages/app/src/state/execution.ts`

Downstream consumers to keep compatible with:

- `rivet/packages/app/src/components/ActionBar.tsx`
- `rivet/packages/app/src/components/ActionBarMoreMenu.tsx`
- `rivet/packages/app/src/components/DebuggerConnectPanel.tsx`
- `wrapper/web/overrides/hooks/useRemoteExecutor.ts`
- any Gentrace/remote-run consumers

## Required implementation rules

### Rule 1: the authoritative UI state must be the atom again
The hosted override should read and write the upstream `remoteDebuggerState` atom rather than returning a fake render-time object.

### Rule 2: singleton socket management is acceptable only as an internal detail
A module-level singleton socket is acceptable if it simplifies connection ownership, but the UI must still observe state through the atom.

### Rule 3: hosted override must preserve upstream semantics
The hosted override should still implement the same conceptual transitions as upstream:

- `connect(url)` initiates a session
- `started` becomes true when the app is in an active remote-debugger/executor session
- `reconnecting` reflects actual reconnect attempts
- `remoteUploadAllowed` is false until the server confirms graph upload is allowed
- `isInternalExecutor` is derived from the connection URL, not from selected executor mode

### Rule 4: `onConnect` and `onDisconnect` must be honored
The override currently ignores these callback options. That must be fixed because consumers may rely on them.

## Detailed implementation plan

### Step 1. Reintroduce `remoteDebuggerState` atom usage — DONE
Inside the hosted `useRemoteDebugger` override:

- import and use the upstream `remoteDebuggerState` atom
- remove the pattern where `remoteDebuggerState` is assembled ad hoc in the return object
- ensure every significant socket event updates the atom

Expected behavior:

- all consumers of `useRemoteDebugger()` see the same state
- state changes trigger re-renders where expected

### Step 2. Set `isInternalExecutor` by URL identity — DONE
Hosted mode should preserve the same concept as upstream:

- `isInternalExecutor = (url === RIVET_EXECUTOR_WS_URL)`

It should not be computed as `selectedExecutor === 'nodejs'`.

Reason:

- selected executor is a user choice
- internal executor classification is a property of the active connection URL

Those are not equivalent concepts.

### Step 3. Make `remoteUploadAllowed` truthful — DONE
Do not hardcode `remoteUploadAllowed: true`.

Instead:

- initialize it to `false`
- set it to `true` only when the remote debugger receives `graph-upload-allowed`
- reset it to `false` on disconnect/manual disconnect

Reason:

- upload capability is part of the execution protocol
- treating it as always true can hide real sequencing or compatibility bugs

### Step 4. Make `reconnecting` truthful — DONE
Do not hardcode `reconnecting: false`.

Instead:

- set `reconnecting: false` when a socket opens successfully
- set `reconnecting: true` when an unexpected close occurs and a retry is scheduled
- clear it on manual disconnect

Reason:

- ActionBar visibility depends on this field
- if it lies, the UI cannot be trusted

### Step 5. Preserve `started` semantics carefully — DONE
The meaning of `started` should follow the upstream model closely.

Recommended behavior:

- set `started: true` when a connection attempt/session is initiated
- set `started: false` when the session is intentionally ended or lost in a way that upstream would treat as stopped
- confirm this against downstream UI expectations before making further changes

Important note:

- if the exact upstream semantics make hosted UX undesirable, that should be handled with an explicit hosted UI override, not by lying through `useRemoteDebugger`

### Step 6. Honor lifecycle callbacks — DONE
Restore invocation of:

- `options.onConnect`
- `options.onDisconnect`

These should be called in the same situations as upstream or as close as possible.

### Step 7. Keep hosted URL behavior only where needed — DONE
The hosted override should still keep the hosted-specific parts:

- default URLs from `wrapper/shared/hosted-env.ts`
- internal executor URL identity check using `RIVET_EXECUTOR_WS_URL`
- reconnect target based on hosted URLs instead of localhost

Everything else should stay as aligned with upstream semantics as possible.

---

# Phase 2: verify module identity and alias resolution

Status update:

- DONE: completed a static audit of the primary consumers and alias targets involved in the Run button and executor selection flow
- DONE: alias and resolver coverage was expanded in `wrapper/web/vite.config.ts` so vendored upstream workspace source resolves through `wrapper/web` consistently during build
- NOT DONE: runtime proof in the browser is still pending; the build is now unblocked, but browser-side executor retesting has not been run yet

## Goal
Prove that every critical consumer is using the same override implementation and the same state instances.

## Why this phase matters
There is a contradiction in the observed behavior:

- the hosted override currently reports `started` based on `selectedExecutor === 'nodejs'`
- if that were the only state ActionBar saw, the Run button should remain visible in Node mode
- but the Run button still disappears

This means there may be an additional issue such as:

- mixed module identities
- partial override application
- duplicate state instances
- remount-triggered disconnect behavior interacting with another codepath

## Investigation checklist

Add temporary logging in these locations:

- `wrapper/web/overrides/hooks/useRemoteDebugger.ts`
- `wrapper/web/overrides/hooks/useGraphExecutor.ts`
- `wrapper/web/overrides/hooks/useRemoteExecutor.ts`
- `rivet/packages/app/src/components/ActionBar.tsx`
- `rivet/packages/app/src/components/ActionBarMoreMenu.tsx`
- `rivet/packages/app/src/components/DebuggerConnectPanel.tsx`

For each log point, capture:

- current `selectedExecutor`
- current `remoteDebuggerState.started`
- current `remoteDebuggerState.reconnecting`
- current `remoteDebuggerState.url`
- socket `readyState`
- whether the module is the hosted override or upstream file

## What to prove

### Must prove A
The executor selector in the More menu and the ActionBar are reading the same `selectedExecutorState`.

### Must prove B
All relevant `useRemoteDebugger` consumers are using the hosted override, not a mixture of hosted and upstream implementations.

### Must prove C
Only one authoritative `remoteDebuggerState` exists in the running app.

### Must prove D
A remount or effect cleanup is not disconnecting the socket behind the ActionBar unexpectedly.

## If duplication is found
If logs suggest duplicated module identity or partial alias application:

- inspect `wrapper/web/vite.config.ts`
- verify regex alias patterns are matching the actual raw import specifiers in every consumer
- verify no critical codepath imports the upstream file through a specifier not covered by the current regex aliases
- if needed, tighten or expand aliases to cover the actual import forms used by the build

---

# Phase 3: validate `useGraphExecutor` lifecycle behavior

Status update:

- DONE: completed a static review of the existing `useGraphExecutor` cleanup ownership pattern and confirmed it still has the remount/disconnect risk called out in the plan
- NOT DONE: runtime validation of this lifecycle behavior is still pending browser-side retesting

## Goal
Confirm that socket ownership and effect cleanup do not create a false disconnect in Node mode.

## Why this phase matters
`useGraphExecutor` still contains a cleanup pattern that upstream already labels as subtly dangerous.

Current hosted behavior:

- when `selectedExecutor === 'nodejs'`, connect to `RIVET_EXECUTOR_WS_URL`
- otherwise disconnect
- cleanup always disconnects

Potential risk:

- if the component owning `useGraphExecutor` remounts unexpectedly, cleanup may tear down the socket even though the user still intends to stay in Node mode

## Investigation questions

- Is `RivetApp` stable, or can it remount during ordinary UI transitions?
- Does switching panels, loading a project, or changing graph context cause `useGraphExecutor` cleanup to run?
- Does cleanup run during mode switches in a way that races against reconnect?

## Possible follow-up actions

If this phase reveals lifecycle-driven disconnects, consider one of these:

### Option A
Keep the current `useGraphExecutor` connection ownership, but make the debugger state transitions robust enough that transient remounts no longer break UI state.

### Option B
Move executor connection ownership into a higher-level hosted coordinator that is guaranteed not to remount unexpectedly.

### Option C
Retain current ownership but add a guard so cleanup only disconnects when the socket belongs to the specific session being torn down.

Do not choose a larger refactor unless the logs show that lifecycle ownership is actually the problem.

---

# Phase 4: retest Node execution after state repair

Status update:

- DONE: completed build-based validation after the remote-debugger fix with a successful `wrapper/web` production build
- NOT DONE: browser/runtime executor retests are still pending and should now be run against the repaired build

## Goal
Separate remote-debugger state problems from graph-upload problems.

## Test sequence
Run these in order.

### Test 1. Browser mode sanity check
Expected:

- Browser executor selected
- Run button visible
- fresh unsaved graph runs immediately

Purpose:

- confirm that the remote-debugger repair did not regress the already-fixed browser path

### Test 2. Node mode idle connection check
Expected:

- Node executor selected
- WebSocket connects to `/ws/executor/internal`
- `remoteDebuggerState.started` and `reconnecting` reflect the true connection lifecycle
- Run button remains visible in stable connected state

Purpose:

- confirm the original blocker is fixed at the UI-state level

### Test 3. Node mode reconnect behavior
Expected:

- temporarily stop or interrupt executor connectivity
- UI enters reconnecting state truthfully
- when connectivity returns, the session recovers cleanly
- Run button behavior matches the intended state transitions

Purpose:

- validate that the state model is stable under real failure conditions

### Test 4. Node mode manual disconnect behavior
Expected:

- manual disconnect should clear started/reconnecting/upload state correctly
- UI should reflect intentional disconnect differently from accidental reconnect loops if upstream semantics require that

Purpose:

- confirm manual and automatic disconnect paths are distinct and correct

---

# Phase 5: retest the unsaved-project Node graph upload path

## Goal
After the Run button is stable, determine whether the remaining Node-mode issue is only graph upload/data propagation.

## Known context
The Node executor has previously reported:

- `Graph not found, and no main graph specified.`

Current theory:

- the current graph may not always be visible to the remote executor unless it is injected into `project.graphs` before the run

The hosted `useRemoteExecutor` already attempts to merge:

- `project.graphs`
- current `graphState`

before sending `set-dynamic-data`

That logic may be correct, but it has been difficult to evaluate cleanly because the Run-button issue kept interfering with reproducible Node-mode runs.

## Validation checklist

In Node mode, once the Run button remains stable:

- create or open an unsaved graph
- confirm logs show the correct current graph id
- confirm `project.graphs` contains the current graph id before sending `run`
- confirm `set-dynamic-data` arrives at the executor before the `run` message matters
- verify whether `graph-upload-allowed` is required before dynamic upload can succeed in practice

## Possible outcomes

### Outcome A
The graph-upload issue disappears once debugger state is fixed.

Interpretation:

- earlier failures were mostly caused by socket-state instability

### Outcome B
The graph-upload issue remains reproducible.

Interpretation:

- there is a second independent Node-mode bug in upload ordering, upload permission, or executor state handling

If Outcome B happens, open a separate focused fix plan for `useRemoteExecutor` and executor-side upload sequencing.

---

# Phase 6: decide whether UI semantics need a hosted-specific adjustment

## Goal
Determine whether hosted mode should keep exactly the same Run-button policy as upstream.

## Important principle
Do not make this decision until the upstream state contract has been restored and verified.

## Decision questions

### Question 1
Should Node mode hide the Run button whenever the socket is not currently healthy?

This is the upstream behavior.

### Question 2
Would hosted mode be better if the Run button remained visible but disabled, with a clear “Connecting to executor” status?

That may be better UX in a web deployment.

## Recommendation
First restore correctness using upstream semantics.

Only then consider whether hosted mode should explicitly override `ActionBar` or related UI to provide better web-specific UX.

If that UX change is desired, it should be a deliberate hosted UI decision, not an accidental side effect of a fake debugger-state implementation.

---

# Concrete implementation checklist

## Highest priority changes

- Repair `wrapper/web/overrides/hooks/useRemoteDebugger.ts`
- Reintroduce atom-backed `remoteDebuggerState`
- Remove hardcoded synthetic values for `reconnecting`, `remoteUploadAllowed`, and `isInternalExecutor`
- Restore `onConnect` and `onDisconnect`
- Keep hosted URL defaults and hosted reconnect targets

## Second priority investigation

- Verify alias coverage in `wrapper/web/vite.config.ts`
- Prove all key consumers resolve to the hosted override
- Prove only one authoritative debugger state instance exists

## Third priority validation

- Re-test Browser executor
- Re-test Node executor visibility and connection stability
- Re-test unsaved-project Node graph upload

---

# Suggested debugging signals to preserve during the fix

Keep or temporarily add logs that clearly identify:

- selected executor changes
- debugger state transitions
- socket open/close/reconnect events
- URL used for connect attempts
- `graph-upload-allowed` reception
- `set-dynamic-data` dispatch
- `run` dispatch
- current `project.graphs` keys and current graph id

Avoid vague logs. Every log should make it obvious which module emitted it and which state snapshot it observed.

---

# Success criteria

The fix is complete when all of the following are true:

## State/UI correctness

- Browser mode keeps the Run button available
- Node mode keeps the Run button available whenever the internal executor session is healthy
- reconnecting/manual disconnect behavior is accurately reflected in UI state
- debugger-related UI no longer behaves inconsistently across panels

## Execution correctness

- Browser executor runs fresh unsaved graphs without refresh
- Node executor runs graphs through the hosted executor service reliably
- unsaved-project Node runs do not fail due to missing graph state

## Architectural correctness

- wrapper-owned fixes remain in `wrapper/` and `ops/`
- no hosted customization is moved into `rivet/`
- hosted behavior remains update-safe and alias-based

---

# Fallback plan if the primary hypothesis is wrong

If repairing `useRemoteDebugger` does not solve the disappearing Run button, then pursue this fallback investigation order:

## Fallback 1
Prove or disprove alias misresolution or duplicate module instances.

## Fallback 2
Prove or disprove remount-triggered disconnects from `useGraphExecutor` cleanup.

## Fallback 3
Instrument executor-side connection acceptance and message flow to verify whether the browser is connecting successfully but the session is being dropped or rejected server-side.

## Fallback 4
Only if all of the above fail, re-evaluate whether the hosted wrapper needs a more centralized executor connection coordinator outside the current hook structure.

---

# Final recommendation

Do not redesign the whole wrapper yet.

The next concrete step should be to rewrite hosted `useRemoteDebugger` so it preserves the upstream state contract while still using hosted URLs and hosted connection behavior.

That is the highest-confidence, highest-leverage intervention and the most likely way to unblock reliable Node executor mode without destabilizing the rest of the wrapper.
