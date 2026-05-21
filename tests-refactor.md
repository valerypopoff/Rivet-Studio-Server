# Tests Refactor Plan

This is a planning document for making the test suite leaner, clearer, and more useful without lowering coverage for the behaviors that have broken in production-like use.

Last surveyed: 2026-05-21

## Goals

- Keep enough coverage to protect the hosted editor, workflow storage, publication/history, execution, recordings, launchers, and Kubernetes contracts.
- Remove stale tests that assert old implementation details or duplicate the same behavior through several layers.
- Split large mixed-purpose suites into smaller domain suites with readable fixtures and focused failure output.
- Replace brittle source-text assertions with behavior tests or rendered config assertions wherever possible.
- Make routine local verification faster and more predictable.
- Keep Playwright coverage focused on browser-visible behavior that pure tests cannot prove.
- Preserve the public verification commands while the refactor is in progress.
- Keep `rivet/` read-only; test cleanup should happen in wrapper code, test harnesses, docs, and scripts.

## Non-Goals

- Do not rewrite product code just to make tests easier unless the test pain exposes unnecessary product complexity.
- Do not add a new test framework. Stay with Node's built-in test runner, `tsx`, and the existing Playwright runner.
- Do not require Kubernetes rehearsal for routine API or UI-only test cleanup.
- Do not turn static contract tests into a second copy of every Dockerfile, Helm template, or upstream override.
- Do not create a large helper layer up front. Add a helper only when it removes real repeated setup across multiple tests.

## Current Test Map

| Area | Current location | Current shape | Keep? |
| --- | --- | --- | --- |
| API unit/integration tests | `wrapper/api/src/tests/*.test.ts` | 28 test files, run by `npm --prefix wrapper/api test` | Yes, but split and prune |
| Web pure helper tests | `wrapper/web/tests/*.test.ts` | 3 files, run by `npm run verify:web-pure` | Yes |
| Browser behavior | `wrapper/web/playwright-observe/*.spec.ts` | 15 Playwright specs via `scripts/playwright-observe.mjs` | Yes, keep scenario-focused |
| Repo/deploy static contracts | mostly `wrapper/api/src/tests/phase4-static-contract.test.ts` | Broad source and regex assertions | Reduce sharply |
| Kubernetes render checks | `kubernetes-launcher-config.test.ts`, `phase4-static-contract.test.ts`, `scripts/verify-kubernetes.mjs` | Mixed static plus rendered manifest checks | Prefer rendered manifest checks |

## Main Problems Found

1. `workflow-services.test.ts` has become a catch-all suite.
   - It mixes filesystem tree CRUD, duplication/upload/download, publication, published history, execution, cache invalidation, hosted save behavior, recordings, cleanup, input filtering, and HTTP route tests.
   - The file is large enough that new changes tend to add more local helpers instead of improving shared fixtures.
   - Failure output points at "workflow services" rather than the actual behavior domain.

2. `phase4-static-contract.test.ts` is too broad and too implementation-aware.
   - It reads many repo files directly and matches source snippets, Dockerfile fragments, docs, CI YAML, Vite plugin implementation details, upstream source files, and Helm templates.
   - Some checks are valuable guardrails, but many duplicate implementation text. These will fail during harmless refactors and encourage patching tests instead of verifying behavior.
   - This file also violates the spirit of the `rivet/` read-only boundary by treating upstream source shapes as a local static contract.

3. Managed storage tests include behavior, SQL shape, and implementation text in one layer.
   - `managed-backend-sql.test.ts` has useful coverage for published version history and restore semantics, but several assertions check exact source strings rather than the service behavior or query output.
   - Keep SQL-specific tests only where SQL escaping, migration DDL, or transaction notifications are the real contract.

4. Fixture setup is duplicated across suites.
   - There are already useful helpers under `wrapper/api/src/tests/helpers/`.
   - Workflow project factories, HTTP app setup, execution server setup, cache spies, published-history fixtures, and managed backend harnesses should be shared instead of redefined locally.

5. Test command routing is too monolithic.
   - `wrapper/api/package.json` explicitly lists every API test file in one long command.
   - That gives deterministic ordering, but makes suite organization hard to maintain and hides natural verification groups.

6. Playwright specs should stay browser-contract focused.
   - Recent UI bugs were about focus, keyboard shortcuts, modal layout, inline rename feedback, and project tree state. These deserve Playwright coverage.
   - Pure data transformations and API response parsing should stay in fast pure tests.

7. Some tests have hidden execution-order and environment assumptions.
   - Several workflow tests set `process.env` before dynamically importing workflow modules. Splitting those files must preserve that env-before-import ordering.
   - Test helpers are compiled by `npm --prefix wrapper/api run build`, so helper types must be clean under `tsc`, not only under `tsx --test`.
   - Compatibility scripts currently call specific test files. Moving or renaming those files requires updating `scripts/verify-compatibility.mjs`, root scripts, and docs in the same slice.

8. External-tool tests should be isolated.
   - Helm-render assertions are valuable, but the default API suite should not grow more dependent on external binaries.
   - Kubernetes-specific coverage should live behind `npm run verify:kubernetes` unless the assertion is pure TypeScript and cheap.

## Do-Not-Break Constraints

- Keep `npm --prefix wrapper/api test` and `npm --prefix wrapper/api run build` working throughout the refactor.
- Keep `npm run verify:filesystem`, `npm run verify:local-docker`, `npm run verify:local-docker:split`, `npm run verify:web-pure`, `npm run verify:kubernetes`, and `npm run verify:repo-structure` working with any renamed files.
- Preserve test import ordering when a suite configures env before importing modules.
- Do not rely on shell glob expansion in npm scripts; Windows, GitHub Actions, and the preserve-symlinks runner must resolve the same files.
- Do not export private production helpers only to satisfy tests unless the export is also a cleaner product seam.
- Do not delete any test until the coverage map names the retained test that proves the same contract.

## Target Test Taxonomy

Use these buckets as the destination shape:

| Bucket | Purpose | Preferred test style |
| --- | --- | --- |
| `api:unit` | Pure helpers, mappers, config parsing, request normalization, JSON-path input filter | Direct imports, no HTTP server |
| `api:filesystem-storage` | Filesystem workflow tree, sidecars, publication state, history files, cache invalidation | Temp roots plus direct service calls |
| `api:managed-storage` | Managed workflow rows, endpoint sync, revisions, history, restore, cache invalidation | Managed harness or mocked transaction client |
| `api:execution` | Published/latest endpoint resolution, `createProcessor` options, debugger routing, recordings attachment | Minimal projects plus HTTP execution harness |
| `api:recordings` | Recording persistence, list/filter/delete/cleanup, replay metadata | Direct store tests and one HTTP route smoke path |
| `api:runtime-libraries` | Runtime library config, sync, readiness, prune/audit behavior | Existing harness, split long cleanup suite |
| `api:launchers` | Docker/prod/dev/Kubernetes env rendering and repo structure | Rendered config/manifest assertions |
| `web:pure` | Dashboard helper logic, bridge message validation, API response parsing | `tsx --test` under `wrapper/web/tests` |
| `web:e2e` | Browser-visible interactions and hosted editor integration | Playwright with mocked APIs unless persistence is the point |

## Proposed File Shape

This is a target layout, not a required one-shot rename.

### API Workflow Suites

Start with the smallest useful split. More files are allowed only if one of these files becomes hard to scan.

- `workflow-filesystem-tree.test.ts`
  - folder create/rename/move/delete
  - project rename/move/delete
  - sidecar movement
  - hidden path rejection
  - tree route no-cache headers
  - duplicate from draft or published snapshot
  - upload/import collision naming
  - download draft/published/unpublished-changes variants
  - invalid project upload rejection

- `workflow-publication-filesystem.test.ts`
  - publish/unpublish state transitions
  - endpoint uniqueness
  - full unpublish closes public route families
  - referenced projects remain resolvable after moves

- `workflow-published-history-filesystem.test.ts`
  - each publish creates history
  - legacy current snapshot fallback
  - mismatched metadata rejection
  - star persistence
  - restore republishes as a new current history entry
  - restore invalidates warm execution caches

- `workflow-execution-filesystem.test.ts`
  - published/latest endpoint split
  - request headers context
  - falsy input preservation
  - debug timing headers
  - cache rebuild after mutations
  - missing root recreation

- `workflow-recordings-http.test.ts`
  - execution creates replayable recordings
  - workflow list survives unpublish
  - page/filter/delete routes
  - input filter JSON path behavior
  - cleanup policy

### Managed Workflow Suites

- Keep the already focused managed files unless they become harder to understand after workflow cleanup:
  - `managed-execution-cache.test.ts`
  - `managed-execution-invalidation.test.ts`
  - `managed-execution-service.test.ts`
  - `managed-endpoint-sync.test.ts`
  - `managed-mappers.test.ts`

- Split `managed-backend-sql.test.ts` into at most two files:
  - `managed-workflow-schema.test.ts`: migration/DDL invariants that cannot be proved through services, wildcard escaping SQL for folder moves, published history table/index shape.
  - `managed-publication-history.test.ts`: legacy publish backfill, restore-as-new-publish, star persistence, no-op save state preservation, and real draft-change revision creation.

### Static/Deployment Suites

- `repo-structure.test.ts` or keep `npm run verify:repo-structure`
  - root markdown allow-list
  - authored directory boundaries
  - package launcher script expectations

- `proxy-image-contract.test.ts`
  - render/parse nginx templates enough to prove route ownership and timeouts
  - image namespace, GHCR paths, multi-arch matrix, required build contexts
  - avoid asserting every nearby line of shell or Dockerfile text

- `hosted-editor-seams.test.ts`
  - wrapper uses `RivetAppHost`, hosted file-menu policy, storage provider, executor URL split
  - no assertions against upstream source unless upstream has no stable wrapper-facing API

- `kubernetes-contract.test.ts`
  - rendered local/prod manifests prove control/execution split, health probes, Vault dotenv contract, image repositories, and service routing
  - prefer `helm template` output over regexes against templates

## Delete Or Replace Candidates

| Candidate | Action | Reason |
| --- | --- | --- |
| Source-snippet assertions in `phase4-static-contract.test.ts` | Replace | They duplicate implementation details and drift on harmless refactors |
| Upstream `rivet/` source assertions in local tests | Delete or replace with wrapper behavior checks | Upstream files are read-only inputs and change outside this repo |
| Multiple route-level tests for the same workflow storage branch | Collapse to one route smoke test plus service-level behavior tests | Route tests are slower and harder to diagnose |
| Exact Dockerfile line assertions | Replace with rendered image/compose contract checks where possible | The runtime contract matters more than line placement |
| SQL source string assertions for managed publication logic | Replace with mocked transaction behavior tests | The service contract is publish/restore/invalidate, not a source phrase |
| Manual UI checklist duplicated by Playwright | Keep one source of truth | Docs should say what to validate; Playwright should automate stable flows |

## Keep And Strengthen

- Cache invalidation tests for published restore, publish, unpublish, save, folder move, and endpoint rename.
- Published/latest endpoint split tests, including "latest uses draft only when published lineage exists".
- Remote debugger routing tests proving latest can emit debugger events while published stays debugger-free.
- Recording input filter tests, especially `undefined` JSON-path resolution.
- Runtime-library readiness and cleanup tests because those represent Kubernetes multi-replica behavior.
- Launcher and Kubernetes rendered-manifest tests because operator docs depend on those contracts.
- Playwright tests for keyboard shortcut interception and hosted editor focus behavior.

## Coverage Inventory Template

Use this before deleting or rewriting tests. It can live directly in a refactor PR description if maintaining it inside this file becomes noisy.

| Existing test | Contract protected | Current layer | Disposition | Replacement/retained proof |
| --- | --- | --- | --- | --- |
| `workflow-services.test.ts` test name | Example: restore invalidates filesystem execution cache | HTTP/service | move | `workflow-published-history-filesystem.test.ts` |
| `phase4-static-contract.test.ts` assertion group | Example: published routes proxy to execution upstream | static/rendered config | rewrite | `proxy-image-contract.test.ts` rendered route assertion |

## Phase 0 Snapshot

Implemented: 2026-05-21

### Baseline Commands

| Command | Result | Notes |
| --- | --- | --- |
| `npm --prefix wrapper/api run build` | Pass | Confirms current API source and test helpers type-check under `tsc`. |
| `npm --prefix wrapper/api test` | Fail | Escalated rerun: 124 pass, 11 fail. Failures are baseline dependency bootstrap errors from linked Rivet packages missing `ai`, `openai`, and `@ai-sdk/anthropic` under `rivet/node_modules`. |
| `npm run verify:web-pure` | Pass after escalation | First sandboxed run failed because `npx` could not access npm cache/registry. A follow-up cleanup switched root/compatibility verification from `npx tsx` to the local `wrapper/api` `tsx` toolchain. |
| `npm run verify:repo-structure` | Pass | The new `tests-refactor.md` root working doc is accepted by the repo-structure guardrail. |

### Baseline Failures

The API suite is red before any test refactor work. The failure is not caused by this plan: `wrapper/api` links `@valerypopoff/rivet2-core` and `@valerypopoff/rivet2-node` through `rivet/node_modules`, and this checkout is missing upstream runtime packages now imported by the built Rivet core package.

Confirmed missing paths:

- `rivet/node_modules/ai`
- `rivet/node_modules/openai`
- `rivet/node_modules/@ai-sdk/anthropic`
- `wrapper/api/node_modules/.rivet-package-links/rivet-core/node_modules/ai`
- `wrapper/api/node_modules/.rivet-package-links/rivet-core/node_modules/openai`
- `wrapper/api/node_modules/.rivet-package-links/rivet-core/node_modules/@ai-sdk/anthropic`

Failing API test files from the escalated baseline:

- `api-profile.test.ts`
- `filesystem-execution-cache.test.ts`
- `filesystem-execution-source.test.ts`
- `filesystem-recordings-root.test.ts`
- `hosted-project-title.test.ts`
- `latest-workflow-remote-debugger.test.ts`
- `managed-backend-sql.test.ts`
- `managed-catalog.test.ts`
- `managed-execution-service.test.ts`
- `native-io.test.ts`
- `workflow-services.test.ts`

The first sandboxed API run also showed `spawnSync helm EPERM` inside `phase4-static-contract.test.ts`, but the escalated API rerun proved that Helm-render case is green on this machine. Treat the Helm EPERM as a sandbox/tooling artifact, not as a test-suite failure.

Do not begin Phase 1 until the dependency baseline is refreshed and the API suite is rerun. The expected remediation is `npm run setup`, then `npm --prefix wrapper/api test`.

Tooling gap fixed during reassessment: root `verify:web-pure`, root `verify:kubernetes`, and the compatibility script's focused `tsx --test` checks now use `npm --prefix wrapper/api exec -- tsx` instead of `npx tsx`, so those verification paths no longer fetch `tsx` from npm during a normal run.

### Coverage Inventory

This is file-level inventory. When a file is split or a test is deleted, the implementation PR should use the template above for individual test names.

| Test file | Contracts protected | Current layer | Disposition | Replacement/retained proof |
| --- | --- | --- | --- | --- |
| `api-profile.test.ts` | API profile route exposure, startup preconditions, safe error messages, runtime-library permission route | HTTP/config | Keep | Same file, possibly smaller route fixtures |
| `docker-launcher-env.test.ts` | Docker launcher env derivation, managed compose profile activation, retired env aliases, NODE_OPTIONS filtering | Pure config | Keep | Same file |
| `editor-bridge.test.ts` | Dashboard/editor bridge command and event validation | Pure shared contract | Keep | Same file |
| `exec.test.ts` | Cross-platform spawn invocation and proxy bootstrap env cleanup | Pure helper | Keep | Same file |
| `filesystem-execution-cache.test.ts` | Filesystem endpoint pointer warming, materialization invalidation, dirty rebuild races, root resets | Service/cache | Keep | Same file |
| `filesystem-execution-source.test.ts` | Published/latest source selection, stale candidate skipping, project/dataset materialization signatures | Service | Keep | Same file |
| `filesystem-recordings-root.test.ts` | Separate workflow/recording roots, recording bundle persistence, index drift repair, cleanup warning paths | Service/filesystem | Keep | Same file |
| `hosted-project-title.test.ts` | Hosted project title normalization for filesystem and managed saves | Service | Keep | Same file |
| `kubernetes-launcher-config.test.ts` | Local Kubernetes launcher env, object storage derivation, rendered values/secrets, provider validation | Rendered config | Keep | `verify:kubernetes` |
| `latest-workflow-remote-debugger.test.ts` | Latest debugger event routing, published debugger isolation, websocket auth/profile availability | HTTP/websocket | Keep | Same file |
| `managed-backend-sql.test.ts` | Managed folder SQL escaping, schema/history DDL, publication/history/restore/save source checks | Mixed static/service | Rewrite/split | `managed-workflow-schema.test.ts` and `managed-publication-history.test.ts` |
| `managed-catalog.test.ts` | Managed workflow tree stats and broken draft blob fallback | Managed service | Keep | Same file |
| `managed-endpoint-sync.test.ts` | Managed endpoint uniqueness, conflict handling, stale endpoint reclaim, visibility flags | Managed service | Keep | Same file |
| `managed-execution-cache.test.ts` | Managed pointer invalidation and revision materialization LRU behavior | Pure cache | Keep | Same file |
| `managed-execution-invalidation.test.ts` | Workflow/global generations, listener health, self-notify suppression, transactional `pg_notify` | Managed service/mock | Keep | Same file |
| `managed-execution-service.test.ts` | Managed execution pointer cache hits/misses, invalidation races, reference materialization and failure propagation | Managed service/mock | Keep | Same file |
| `managed-mappers.test.ts` | Workflow status and row-to-item mapping | Pure mapper | Keep | Same file |
| `migrate-workflow-storage.test.ts` | Migration status derivation and verification comparison logic | Pure migration helper | Keep | Same file |
| `native-io.test.ts` | Native IO path validation, route error preservation, `readDir` include/ignore filters | Service/helper | Keep | Same file |
| `phase4-static-contract.test.ts` | Proxy/image/CI/hosted-editor/Kubernetes static contracts | Static/rendered config | Rewrite/split | `proxy-image-contract.test.ts`, `hosted-editor-seams.test.ts`, `kubernetes-contract.test.ts`, `verify:repo-structure` |
| `plugin-installer.test.ts` | Plugin package metadata URL encoding and package/tag validation | Pure helper | Keep | Same file |
| `recording-input-filter.test.ts` | Recording input JSON-path root semantics, string table restoration, invalid filter rejection, artifact read bounds | Pure/service helper | Keep | Same file |
| `recordings-store.test.ts` | Recording store initialization reuse, cleanup reruns, queue overflow behavior, non-fatal cleanup errors | Service | Keep | Same file |
| `runtime-libraries.test.ts` | Filesystem runtime-library manifest, active release reconciliation, job visibility, retired env rejection | Service/filesystem | Keep | Same file |
| `runtime-library-cleanup.test.ts` | Runtime-library config parity, managed schema lock, audit/prune, replica readiness aggregation | Service/mock | Keep, maybe split only if edits become noisy | Same file or focused runtime-library cleanup files |
| `workflow-publication.test.ts` | Filesystem endpoint reservation for unpublished, draft, and published identities | Service | Merged | `workflow-publication-filesystem.test.ts` |
| `workflow-services.test.ts` | Workflow tree CRUD, import/export, publish/history, execution, recordings, cache and route behavior | Mixed service/HTTP | Move/split | Files named in "API Workflow Suites" |
| `workflow-storage-config.test.ts` | Managed storage env aliases, retired env rejection, blob key namespacing, integer parser semantics | Pure config | Keep | Same file |
| `wrapper/web/tests/api-request.test.ts` | Dashboard API response parsing and error shaping | Web pure helper | Keep | Same file |
| `wrapper/web/tests/hosted-fonts.test.ts` | Hosted editor font-family coverage for upstream styles | Web pure helper | Keep | Same file |
| `wrapper/web/tests/opened-project-metadata.test.ts` | Hosted project tab/title metadata normalization | Web pure helper | Keep | Same file |
| `folder-inline-rename.spec.ts` | Folder inline rename UX, save/cancel feedback, and tree state | Playwright UI | Keep | Same spec |
| `hosted-editor-observe.spec.ts` | Manual observable hosted editor focus handoff and clipboard recovery flow | Playwright UI/manual | Keep as opt-in/debug, not default release gate | Same spec |
| `hosted-editor-search-shortcuts.spec.ts` | Ctrl/Cmd+F routing into Rivet search without stealing text input focus | Playwright UI | Keep | Same spec |
| `hosted-file-menu.spec.ts` | Hosted File menu policy visibility | Playwright UI | Keep | Same spec |
| `managed-special-paths.spec.ts` | Managed path/special project-tree path handling | Playwright UI | Keep | Same spec |
| `overlay-tabs.spec.ts` | Dashboard overlay tab behavior | Playwright UI | Keep | Same spec |
| `project-inline-rename.spec.ts` | Project inline rename UX and F2 behavior | Playwright UI | Keep | Same spec |
| `project-settings-modal.spec.ts` | Project settings modal publish/history actions and settings affordances | Playwright UI | Keep | Same spec |
| `project-tab-labels.spec.ts` | Hosted editor tab labels and title updates after save | Playwright UI | Keep | Same spec |
| `renamed-open-project-cache.spec.ts` | Open-project cache behavior after rename | Playwright UI | Keep | Same spec |
| `run-recordings-modal.spec.ts` | Run recordings modal selection, filtering, pagination, replay open, and delete flows | Playwright UI | Keep | Same spec |
| `runtime-libraries-cancel.spec.ts` | Runtime-library modal cancellation flow | Playwright UI | Keep | Same spec |
| `runtime-libraries-modal.spec.ts` | Runtime-library modal display/readiness behavior | Playwright UI | Keep | Same spec |
| `workflow-library-layout.spec.ts` | Workflow library/sidebar layout and project state presentation | Playwright UI | Keep | Same spec |
| `workflow-project-version-modal.spec.ts` | Published version history modal paging/actions | Playwright UI | Keep | Same spec |

## Fixture Refactor Plan

Prefer extending the existing helpers under `wrapper/api/src/tests/helpers/` before adding new files:

- `http-server-harness.ts`
- `managed-backend-harness.ts`
- `runtime-library-harness.ts`
- `websocket-harness.ts`
- `workflow-fixtures.ts`

Only add these if the split proves they are needed:

- `workflow-api-harness.ts`
  - project factories: blank project, input echo project, headers context echo project, graph-reference project, dataset-sidecar project.
  - route harnesses: control-plane workflow routes, published/latest execution routes, JSON helpers with useful error messages, route cleanup.
  - publication helpers: publish a draft, create unpublished changes, read published history, restore a history version, assert current status.
  - cache helpers: reset cache, observe invalidation calls, count warm/cold materialization, force in-flight invalidation races.

- `managed-transaction-harness.ts`
  - scripted query responses
  - transaction event recording
  - helper assertions for `pg_notify`, local invalidation, and rollback behavior

Rules for helpers:

- Helpers must build domain language, not hide assertions.
- Test files should still show the behavior being proved.
- Helpers must avoid global mutable state unless they provide a reset function used by `beforeEach`.
- Temp roots must be per suite or per test and always cleaned up by the Node test context where practical.
- A new helper should have at least two immediate call sites, and preferably three.

## Script Refactor Plan

Keep the existing top-level commands stable, then add finer-grained commands behind them.

Prefer a deterministic manifest runner over shell globs. Shell globs are easy to write but are not portable enough for this repo's Windows plus GitHub Actions workflow.

Potential API scripts:

```json
{
  "test": "npm run test:api",
  "test:api": "node ../../scripts/run-api-test-group.mjs all",
  "test:api:unit": "node ../../scripts/run-api-test-group.mjs unit",
  "test:api:storage": "node ../../scripts/run-api-test-group.mjs storage",
  "test:api:execution": "node ../../scripts/run-api-test-group.mjs execution",
  "test:api:deploy": "node ../../scripts/run-api-test-group.mjs deploy"
}
```

The runner can be tiny: it should map group names to explicit file arrays, sort only where order is not meaningful, and execute `node ../../scripts/run-preserve-symlinks.mjs tsx --test ...`. Keep this as a final-phase cleanup, after files have settled.

Root scripts should keep these stable:

- `npm run verify:filesystem`
- `npm run verify:filesystem:docker`
- `npm run verify:local-docker`
- `npm run verify:local-docker:split`
- `npm run verify:repo-structure`
- `npm run verify:web-pure`
- `npm run verify:kubernetes`

## Refactor Phases

### Phase 0: Baseline, Inventory, And Safety Net (DONE)

1. Run `npm --prefix wrapper/api run build`.
2. Run `npm --prefix wrapper/api test`.
3. Run `npm run verify:web-pure`.
4. Run `npm run verify:repo-structure`.
5. Create a one-time coverage inventory in this plan or a temporary scratch note:
   - test name
   - behavior protected
   - layer: pure, service, HTTP, static, Playwright
   - disposition: keep, move, rewrite, delete
   - replacement test if deleted
6. Record current failures separately from refactor failures.
7. Do not proceed with mass moves if the baseline is red for unrelated reasons.

### Phase 1: Extract Shared Fixtures Only (DONE)

1. Move repeated project creation, HTTP server setup, and cache spy code into helpers.
2. Keep test names and assertions unchanged.
3. Run the affected tests after each helper extraction.
4. Stop if helper extraction makes a test harder to read.

Outcome:

- Added `wrapper/api/src/tests/helpers/workflow-api-harness.ts` for workflow HTTP harnesses, JSON response handling, env overrides, recording waiters, and filesystem execution cache invalidation probes.
- Added `createRootPublishedProjectFactory(...)` to `wrapper/api/src/tests/helpers/workflow-fixtures.ts` and replaced the duplicated root-level filesystem execution project-publish helper in the cache/source suites.
- Kept test file ownership unchanged at Phase 1 completion; `workflow-services.test.ts` still contained the workflow service tests until the Phase 2 split.
- Corrected one stale cache-refresh assertion discovered during verification: `saveHostedProject` normalizes `project.metadata.title` to the file name, so the materialization refresh test now mutates graph metadata instead of title metadata.
- Corrected two baseline test-harness issues surfaced by the full API command: `hosted-project-title.test.ts` now sets filesystem env before importing filesystem helpers, and the managed publication static test now checks the current backfill helper shape.
- Verified with `npm --prefix wrapper/api run build`, `npm --prefix wrapper/api test`, `npm run verify:repo-structure`, the affected filesystem execution suites, and the full `workflow-services.test.ts` suite.

### Phase 2: Split `workflow-services.test.ts` (DONE)

1. Move tests into the minimum target workflow suite files by behavior domain.
2. Keep assertions semantically identical during the move.
3. Update `wrapper/api/package.json` and `scripts/verify-compatibility.mjs` in the same commit as any file rename.
4. Delete local helpers only after all moved tests use shared helpers.
5. Keep one temporary compatibility run of the old suite name only if needed during migration; remove it before the phase is complete.

Outcome:

- Deleted the catch-all `wrapper/api/src/tests/workflow-services.test.ts`.
- Moved its 72 tests into the planned workflow domain suites:
  - `workflow-filesystem-tree.test.ts`
  - `workflow-publication-filesystem.test.ts`
  - `workflow-published-history-filesystem.test.ts`
  - `workflow-execution-filesystem.test.ts`
  - `workflow-recordings-http.test.ts`
- Added `workflow-filesystem-suite-harness.ts` so the split suites share the temp-root/env bootstrap and cleanup, dynamic workflow-module imports, and HTTP route harness construction without duplicating the import-order-sensitive setup.
- Merged the two endpoint-reservation tests from `workflow-publication.test.ts` into `workflow-publication-filesystem.test.ts`, then deleted the old tiny publication file so filesystem publication coverage has one home.
- Updated `wrapper/api/package.json` so the public API test command runs the split suites directly. `scripts/verify-compatibility.mjs` did not require a file-list change because it delegates the filesystem baseline to `npm --prefix wrapper/api test` and has no stale `workflow-services.test.ts` reference.
- Removed the temporary old-suite path entirely; there is no compatibility run for `workflow-services.test.ts`.
- Verified the moved tests with the five new workflow suite files as a focused run before the full verification pass.

### Phase 3: Reduce Static Contract Tests

1. Categorize each `phase4-static-contract.test.ts` assertion as:
   - rendered runtime contract
   - repo layout guardrail
   - wrapper/upstream seam guardrail
   - implementation duplicate
   - stale assertion
2. Keep rendered/runtime contracts.
3. Move repo layout checks to `verify:repo-structure` when they are structural.
4. Replace source-snippet checks with exported helper tests when there is a real code contract.
5. Delete stale assertions that only preserve old implementation wording.
6. Move Helm-dependent checks behind `npm run verify:kubernetes` if they are not required by the default API test command.

### Phase 4: Managed Storage Cleanup

1. Separate schema/SQL invariants from service behavior.
2. Keep wildcard escaping and migration DDL tests.
3. Move publish/history/restore/no-op-save tests to service-level harnesses.
4. Add direct restore cache invalidation coverage if it is not already covered after the split.

### Phase 5: Playwright Review

1. Keep Playwright for browser-only behavior:
   - iframe focus and shortcuts
   - inline rename interactions
   - modal paging/layout that can clip in the browser
   - hosted file menu visibility
   - published version history modal actions
2. Prefer mocked API responses for UI-only paths.
3. Use real storage mutation only when persistence is the behavior under test.
4. Ensure every browser-visible feature has at most one canonical happy path plus targeted edge cases.

### Phase 6: Command And CI Cleanup

1. Introduce grouped API test scripts through a deterministic manifest runner if grouping still helps after the file split.
2. Keep existing public verification commands working.
3. Update `docs/development.md` with the final command map.
4. Make CI use the same commands developers run locally.

### Phase 7: Final Prune

1. Remove old catch-all files after their tests have moved.
2. Remove unused helpers.
3. Run full repo-local verification:
   - `npm --prefix wrapper/api test`
   - `npm --prefix wrapper/api run build`
   - `npm run verify:web-pure`
   - `npm run verify:repo-structure`
   - `npm run verify:kubernetes` if deployment/static tests changed
4. Run Playwright only for browser-visible test changes.

## Quality Bar For Each Test

Every retained test should answer yes to these questions:

- Does the test protect a user-visible, operator-visible, or integration-visible contract?
- Would a regression here plausibly break hosted editing, endpoint execution, publication/history, recordings, runtime libraries, launchers, or Kubernetes?
- Is this the lowest practical layer for the assertion?
- Is the failure message likely to point to the broken behavior?
- Does the test avoid asserting incidental source layout, function names, or line order?
- Does it use a shared fixture instead of rebuilding large setup locally?
- Does it avoid sleeping unless it is polling an async boundary with a clear timeout?

## Review Checklist For Stale Tests

Mark a test stale and remove or rewrite it when:

- it asserts a source snippet that is not the public contract;
- it duplicates another test at a slower layer;
- it preserves a bug workaround that is no longer in the product;
- it reads from `rivet/` to enforce an upstream implementation shape instead of wrapper behavior;
- it requires a full HTTP server where a service call proves the same thing;
- it has broad names like "keeps contract stable" without naming the actual contract;
- it can fail because of harmless formatting or file organization changes.

## Verification Matrix After Refactor

| Change type | Required verification |
| --- | --- |
| API helper/test-only move | Affected API test file, then `npm --prefix wrapper/api test` before merge |
| API behavior coverage rewrite | Affected test group, `npm --prefix wrapper/api test`, `npm --prefix wrapper/api run build` |
| Static/deploy contract rewrite | `npm run verify:repo-structure`; add `npm run verify:kubernetes` if Helm/image/proxy contracts changed |
| Web pure test rewrite | `npm run verify:web-pure` |
| Playwright spec cleanup | `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0`, `node scripts/playwright-observe.mjs test` |
| Runtime-library or managed-storage coverage | Repo-local tests plus managed Docker rehearsal when persistence or readiness is involved |

## Suggested Commit Slices

1. Add shared workflow and HTTP test helpers. (DONE)
2. Split workflow tree/copy/import/export tests out of `workflow-services.test.ts`. (DONE)
3. Split publication/history/execution/recordings tests out of `workflow-services.test.ts`. (DONE)
4. Refactor managed publication/history tests away from source-string assertions.
5. Split and shrink `phase4-static-contract.test.ts`.
6. Normalize test scripts and update docs.
7. Final prune of stale tests and unused helpers.

Keep each slice behavior-preserving except the explicit stale-test deletion slice. That makes review much easier than one giant "test cleanup" diff.

## Open Questions Before Implementation

- Should API test grouping preserve strict file order, or is deterministic sorted discovery enough?
- Are any current tests intentionally guarding an old upstream seam that should now be deleted after the `RivetAppHost` migration?
- Which Playwright specs are considered required release gates versus local debugging aids?
- Should `verify:kubernetes` stop depending on the broad static contract suite once rendered Helm checks cover the same route/image contracts?
- Should published version history restore receive one managed-mode integration test with a real Postgres rehearsal, or is the mocked managed harness enough for CI?

## Definition Of Done

- `workflow-services.test.ts` is either gone or small enough to have one clear reason to exist.
- `phase4-static-contract.test.ts` is split or reduced to stable contracts only.
- Static tests no longer assert long source snippets that duplicate implementation.
- Tests are grouped by behavior domain and can be run selectively.
- Docs describe the new test command map.
- Routine verification remains no heavier than today's repo-local baseline.
- No changes are made under `rivet/`.
