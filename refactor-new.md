# Refactor Plan

## Purpose

This plan replaces the older report in `refactor-old.md`.

Several items from the previous report are already implemented in the current codebase, so this document focuses only on the refactors that still matter now.

The goal is not to redesign the product. The goal is to make the current hosted Rivet wrapper smaller, clearer, safer to change, and easier to open source without weakening behavior.

## Refactor Goals

- Keep all current user-visible functionality and deployment behavior described in `description.md`
- Increase maintainability by reducing hidden coupling across `wrapper/web`, `wrapper/api`, `wrapper/shared`, and `ops`
- Remove unnecessary complexity and wrapper-specific overengineering where it does not buy reliability
- Reduce code volume, especially duplicate flow control, repeated validation, and generated artifacts mixed with source
- Make the codebase easier for new open-source contributors to understand
- Improve production readiness by making critical behavior easier to verify and less fragile during future changes

## Non-Negotiable Requirements

- Do not change the product model: this remains a hosted wrapper around vendored upstream Rivet, not a forked rewrite
- Do not move hosted behavior into `rivet/` unless there is no practical wrapper-level alternative
- Preserve every regression-sensitive behavior listed in `description.md`
- Prefer deleting code over adding abstraction
- Prefer explicit modules with narrow responsibilities over shared utility layers that hide behavior
- Every phase must be landable independently and leave the app in a releasable state

## Current Findings

The current codebase is in a better state than `refactor-old.md` assumes. Important hardening work is already present:

- API auth middleware scaffolding exists
- request validation is already moving to `zod`
- path and error leakage have been reduced
- Vite aliasing has already been split out
- shared path normalization has already been extracted

The remaining problems are different:

- there is still no wrapper-level regression test harness
- workflow behavior is split across multiple route/helper files with duplicated file-system orchestration
- the dashboard/editor integration depends on an untyped ad hoc `postMessage` protocol
- a few components and route files still own too much behavior at once
- runtime library management still carries more state machinery than the feature justifies
- generated build output is checked into source trees, which blurs source of truth and increases review noise
- wrapper code is not yet organized for outside contributors to quickly understand the boundaries

## Refactor Strategy

The work should happen in this order:

1. Lock behavior down with tests around the wrapper-owned contract.
2. Simplify the workflow backend because it is the highest-value business logic in the wrapper.
3. Simplify the dashboard/editor boundary because it is the highest-friction frontend integration.
4. Reduce operational and generated-code noise so the repository has a clear source of truth.
5. Only then do smaller cleanup passes.

## Phase 0: Add a Wrapper Regression Harness - DONE

This phase is mandatory before meaningful structural refactors.

### Why

`description.md` is acting as both product spec and regression checklist, but it is not executable. Right now there are effectively no wrapper-level tests, which makes behavior-preserving refactors too risky.

### Changes

- Add API integration tests for `wrapper/api`
- Add a small browser-level integration layer for the dashboard flows most likely to break
- Turn the most important parts of the `description.md` checklist into executable acceptance tests

### Minimum API coverage

- workflow tree listing
- create, rename, move, and delete folder/project
- sidecar movement for `.rivet-data` and `.wrapper-settings.json`
- publish, unpublish, latest path, and published path behavior
- case-insensitive endpoint uniqueness
- deletion cleaning up snapshots and sidecars
- runtime library install/remove happy path and failure path

### Minimum frontend coverage

- open project from dashboard
- selected project vs opened project behavior
- save via dashboard button
- save shortcut behavior outside iframe
- move open project and continue saving to new path
- zero-open-project empty state and forced sidebar behavior

### Expected outcome

- safer refactors
- clearer product contract for open-source contributors
- fewer manual regressions during architecture cleanup

## Phase 1: Consolidate Workflow Backend Logic - DONE

The workflow feature set is the most important wrapper-owned product logic, and it is currently spread across `index.ts`, `tree.ts`, `publication.ts`, `execution.ts`, and `fs-helpers.ts`.

### Problems

- file-system moves, sidecar handling, publication state, and endpoint resolution are split across route-shaped modules instead of capability-shaped modules
- route handlers still know too much about file layout
- several operations repeat the same sequence: resolve path, validate type, inspect sidecars, mutate disk, rebuild response

### Refactor

Create a workflow service layer under `wrapper/api/src/routes/workflows/` with a structure close to:

- `workflow-files.ts`
- `workflow-projects.ts`
- `workflow-publication.ts`
- `workflow-query.ts`

The route file should become thin request/response glue only.

### Specific simplifications

- centralize project-path resolution and project-path type checks
- centralize rename/move semantics including case-only rename handling
- centralize sidecar move/delete logic so it exists once
- centralize workflow response hydration so folder/project JSON shaping is not scattered
- centralize endpoint lookup and publication-state calculation

### Expected outcome

- less route duplication
- fewer places that need to know about sidecar rules
- easier testing of workflow logic without HTTP-level boilerplate
- lower risk when adding future features like import/export or bulk operations

## Phase 2: Replace the Ad Hoc Dashboard/Editor Protocol With a Typed Bridge - DONE

The dashboard and embedded editor coordination is one of the most fragile parts of the app. `DashboardPage.tsx` and `EditorMessageBridge.tsx` exchange stringly typed `postMessage` commands and events with duplicated assumptions on both sides.

### Problems

- command/event names are duplicated manually
- payload validation is implicit
- bridge behavior is mixed into large React components
- save/open/delete/move coordination is difficult to reason about

### Refactor

Move the bridge contract into `wrapper/shared` and define explicit message types for:

- dashboard-to-editor commands
- editor-to-dashboard events

Then build small send/receive helpers so both sides depend on the same contract.

### Specific simplifications

- remove repeated string literal checks
- isolate message serialization and validation from UI components
- move pending-command buffering out of `DashboardPage.tsx`
- move editor bridge side effects out of one monolithic component into focused handlers

### Expected outcome

- less fragile iframe coordination
- smaller React components
- easier onboarding for contributors because the integration contract becomes explicit

## Phase 3: Split Large Frontend Components by Responsibility - DONE

The dashboard works, but some wrapper-owned components still bundle too much state, orchestration, and rendering together.

### Primary targets

- `wrapper/web/dashboard/WorkflowLibraryPanel.tsx`
- `wrapper/web/dashboard/DashboardPage.tsx`
- `wrapper/web/dashboard/ProjectSettingsModal.tsx`
- `wrapper/web/dashboard/RuntimeLibrariesModal.tsx`

### Problems

- data loading, command orchestration, drag/drop rules, modal state, and rendering live in the same component
- local helper functions encode product rules that should be easier to find and test
- the project tree, active project logic, and settings/runtime-library actions are too tightly coupled

### Refactor

Split each large component into:

- a stateful container or hook
- pure view components for rows/sections/modals
- focused domain helpers for tree operations and active-project selection

### Guardrails

- do not introduce a generic component framework
- do not replace straightforward local state with heavier state management
- do not move wrapper-specific UI logic into vendored upstream code

### Expected outcome

- less code per component
- easier review of future UI changes
- easier targeted testing of behavior like drag/drop and active-project resolution

## Phase 4: Simplify Runtime Library Management Without Weakening Reliability - DONE

The runtime library feature is valuable, but its internal implementation still carries more release-management machinery than the product needs.

### Problems

- release state is spread between manifest fields, numbered directories, and pointer-file logic
- the job runner mixes orchestration, logging, filesystem mutation, validation, and activation
- API responses expose internal release mechanics that are not important to users
- the in-memory active-job model is weakly defined across restarts

### Refactor

Keep the user-facing feature set, but simplify the internal model:

- make the manifest the single durable source of truth
- keep one activation model that is easy to inspect on disk
- reduce the number of helper functions required to understand a release switch
- separate package-set calculation, install execution, validation, and activation into small units

### Reliability requirement

Any simplification here must preserve the current important property: a failed install must not break the last good runtime library set.

### Expected outcome

- less code in `manifest.ts` and `job-runner.ts`
- easier recovery and reasoning
- fewer moving parts for operators

## Phase 5: Narrow and Normalize API Route Shapes - DONE

The API has improved, but route organization still reflects implementation history more than a stable public wrapper contract.

### Problems

- some routes are thin and consistent, others still embed domain logic
- `native.ts` remains a grab bag of file operations with its own path/baseDir behavior
- response shapes and error handling are not uniformly normalized

### Refactor

- extract route-local domain logic out of `native.ts`, `plugins.ts`, and runtime-library routes
- define consistent response and error conventions for wrapper-owned endpoints
- split broad route files when that reduces code, not just for aesthetic reasons
- narrow `native` operations to the subset actually used by the hosted wrapper, or clearly separate compatibility endpoints from wrapper-specific endpoints

### Expected outcome

- smaller route files
- fewer hidden compatibility layers
- easier future auth and audit work

## Phase 6: Clean Up Source-of-Truth Boundaries - DONE

For an open-source project, the repository needs to make it obvious which files are authored source and which are generated output.

### Problems

- checked-in build output exists under wrapper source trees
- compiled artifacts increase search noise and can make stale code look authoritative
- repository navigation is harder than it should be

### Refactor

- stop treating generated `dist` output as authored code
- keep build artifacts out of normal source review paths
- update ignores, scripts, and deployment steps so the build is reproducible from source

### Expected outcome

- smaller review surface
- fewer false positives when searching the repo
- clearer open-source contributor experience

## Phase 7: Reduce Incidental Ops and Dev Complexity - DONE

The product architecture is already clear, but the local/dev/ops tooling can be simplified further so the codebase is easier to run and reason about.

### Targets

- root scripts
- local env loading
- Docker/dev runner overlap
- wrapper build/start assumptions

### Refactor

- keep one obvious development path for local work and one for Docker work
- reduce duplicated environment setup logic across scripts where practical
- document exactly which outputs are runtime artifacts and which are build inputs

### Expected outcome

- easier onboarding
- fewer environment-specific surprises
- less maintenance burden in repo-level scripts

## Phase 8: Documentation Restructure for Open Source Readability - DONE

This is not just cleanup. It directly affects maintainability.

### Refactor

Add short architecture docs that answer:

- what belongs in `rivet/` vs `wrapper/`
- how the dashboard/editor bridge works
- how workflow publication works
- how runtime libraries work
- how the dev and production stacks differ

Also split the high-density parts of `description.md` into smaller permanent docs once the refactor lands.

### Expected outcome

- faster contributor onboarding
- fewer accidental boundary violations
- less need for tribal knowledge

## What Not To Do

- do not refactor by introducing large generic abstractions
- do not switch state management libraries
- do not replace explicit file operations with a generic repository layer unless it clearly deletes code
- do not expand the hosted wrapper into a different product from upstream Rivet
- do not chase perfect architecture at the cost of shipping a smaller, clearer codebase

## Suggested Delivery Order

1. Add wrapper regression tests.
2. Refactor workflow backend into service-shaped modules.
3. Introduce typed dashboard/editor bridge contract.
4. Split the largest dashboard components.
5. Simplify runtime library internals.
6. Normalize broad API routes.
7. remove generated source-tree artifacts from the authored code path.
8. tighten docs and dev tooling.

## Success Criteria

The refactor is successful if all of the following are true:

- all behavior in `description.md` still works
- wrapper-level tests cover the critical hosted behaviors
- route files and React components are materially smaller and easier to trace
- workflow behavior is understandable without reading five files at once
- the dashboard/editor message contract is explicit and typed
- runtime library management is easier to reason about than it is now
- generated artifacts no longer compete with source as the apparent truth
- a new contributor can understand the wrapper boundary and make safe changes faster

## Expected Net Effect

This plan should reduce code, not grow it.

Most of the line-count reduction should come from:

- deleting duplicate workflow orchestration
- shrinking large components and route files
- removing generated artifacts from the authored source path
- simplifying runtime-library release/state handling
- replacing implicit integration behavior with a shared typed contract

The result should be a production-ready wrapper that is easier to trust, easier to maintain, and easier to open source without losing the current functionality.
