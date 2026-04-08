# Repo Structure Professionalization Plan

## Summary

The refactor left the **application code layout** in good shape. The repo now feels strongest under `wrapper/`, where ownership boundaries are explicit and professional. The weaker parts are at the **repo root and infrastructure/tooling boundaries**:

- the root is carrying too much mixed meaning: product docs, active planning docs, tracked tool binaries, launcher scripts, deployment assets, and generated/ignored state all sit close together
- the package-manager story is inconsistent: the repo operationally uses `npm` and package-locks, but the root still advertises Yarn
- `ops/` currently mixes true deployment assets with runtime/bootstrap code
- `.tools/` contains tracked Windows-only binaries and unpacked vendored artifacts, which makes the repo feel less professional and less portable

This plan keeps the scope **medium**:
- improve structure and professionalism materially
- do not do a full monorepo workspace migration
- do not move the active working docs out of the repo root
- do not rename major top-level domains like `wrapper/`, `charts/`, or `image/` in this pass

## Current Assessment

### What is already good

- `wrapper/api`, `wrapper/web`, `wrapper/shared`, and `wrapper/executor` are a credible product-code split
- `docs/` is now strong and reflects the real architecture
- `scripts/` is small enough that it can remain flat
- `charts/` is clearly isolated from app code
- `image/` already has a service-oriented internal shape

### What is currently unprofessional or inconvenient

- tracked `.tools/helm.exe`, unpacked Helm contents, and `kind.exe` make the repo look vendor-heavy and platform-specific
- the root `package.json` says Yarn while actual repo operation uses `npm` and per-package `package-lock.json`
- `ops/proxy-bootstrap` is runtime bootstrap code living in the deployment directory
- `ops/bundle-executor.cjs` is executor build/runtime code living in the deployment directory
- `ops/` is too mixed: Compose files, Dockerfiles, compose-only proxy templates, compatibility scripts, runtime bootstrap code, and duplicated proxy assets are all in one flat directory
- root Markdown policy is implicit, not explicit; `README.md`, `AGENTS.md`, `refactor.md`, `backlog.md`, `repo-rearrangement.md`, and `kubernetizing.md` are all mixed without a documented rule
- `kubernetizing.md` is not a polished long-term filename
- several path moves are more coupled than the current plan says: moving Compose files changes relative-path semantics for `env_file`, bind mounts, build Dockerfile paths, and default host-path values
- proxy assets are split across `ops/` and `image/proxy/` today; the plan needs an explicit canonical-source decision so it does not preserve duplication under new paths

## Important Changes Or Additions To Public APIs / Interfaces / Types

### External product contracts: unchanged

These stay behaviorally identical:

- HTTP routes
- websocket routes
- env var names
- Helm values surface
- Docker/Kubernetes launcher entrypoints
- storage behavior
- runtime-library behavior

### Developer-facing command surface

Keep all existing root commands working:

- `npm run dev*`
- `npm run prod*`
- `npm run verify:*`
- `npm run setup`
- `npm run setup:rivet`

Add two developer-only commands:

- `npm run setup:k8s-tools`
  - downloads/pins required local Kubernetes helper tooling into the ignored cache
- `npm run verify:repo-structure`
  - validates repo-structure invariants so the cleanup does not drift

### Internal path changes

These are the approved internal path moves for this pass:

- `ops/proxy-bootstrap/*` -> `wrapper/bootstrap/proxy-bootstrap/*`
- `ops/bundle-executor.cjs` -> `wrapper/executor/build/bundle-executor.cjs`
- `ops/docker-compose.yml` -> `ops/compose/docker-compose.yml`
- `ops/docker-compose.dev.yml` -> `ops/compose/docker-compose.dev.yml`
- `ops/docker-compose.managed-services.yml` -> `ops/compose/docker-compose.managed-services.yml`
- `ops/Dockerfile.api` -> `ops/docker/Dockerfile.api`
- `ops/Dockerfile.executor` -> `ops/docker/Dockerfile.executor`
- `ops/Dockerfile.web` -> `ops/docker/Dockerfile.web`
- `ops/nginx.conf` -> `ops/nginx/default.conf.template`
- `ops/nginx.dev.conf` -> `ops/nginx/default.dev.conf.template`
- `ops/ui-gate-prompt.html` -> delete duplicate; keep `image/proxy/ui-gate-prompt.html` as the single canonical prompt asset
- `ops/normalize-workflow-paths.sh` -> `image/proxy/normalize-workflow-paths.sh`
- `ops/update-check.sh` -> `scripts/update-check.sh`
- `kubernetizing.md` -> `kubernetes-rollout.md`

No other top-level directory renames are in scope for this pass.

## Implementation Plan

### 1. Define and enforce the root contract

**Goal**

Make the root understandable to a new engineer in one glance.

**Implementation**

1. Keep these root domains as the intended authored surface:
   - `wrapper/`
   - `scripts/`
   - `docs/`
   - `charts/`
   - `image/`
   - `ops/`
   - `.github/`
   - `README.md`
   - `AGENTS.md`
   - active working docs at root
   - explicitly non-authored local/generated roots such as `.data/`, `artifacts/`, `.claude/`, and any replacement tool cache under `.data/tools/`

2. Keep active working docs at root, but formalize the rule:
   - root Markdown is allowed only for:
     - `README.md`
     - `AGENTS.md`
     - active engineering working docs such as:
       - `backlog.md`
       - `refactor.md`
       - `repo-rearrangement.md`
       - `kubernetes-rollout.md`
   - future root working docs are allowed only by explicit add-to-allowlist policy in `scripts/verify-repo-structure.mjs`; they should not appear ad hoc
   - all reference, architecture, operator, and contributor docs stay under `docs/`

3. Normalize the awkward filename:
   - rename `kubernetizing.md` to `kubernetes-rollout.md`
   - update all links and references accordingly

4. Update `README.md` to add:
   - a short `Repository Map` section
   - a short `Root Working Docs` section that explicitly lists the root docs and why they remain there

5. Add `docs/repo-structure.md` as the canonical structure reference:
   - top-level directory roles
   - what belongs in `wrapper/`
   - what belongs in `ops/`
   - what belongs in `image/`
   - what belongs in `charts/`
   - what is allowed at repo root
   - what is generated/ignored and not part of the authored surface

**Acceptance result**

A new engineer can infer the intended repo shape from:
- `README.md`
- `docs/repo-structure.md`
- the top-level listing itself

### 2. Remove tracked tool binaries from the repo contract

**Goal**

Stop shipping platform-specific helper binaries in Git.

**Implementation**

1. Remove tracked `.tools/` artifacts from the intended repo surface:
   - `.tools/helm.exe`
   - `.tools/helm-v3.20.1-windows-amd64.zip`
   - `.tools/helm-unpacked/**`
   - `.tools/kind.exe`

2. Do not replace `kind.exe`.
   - current repo launchers do not rely on `kind`
   - this tool is baggage today, not active contract

3. Replace bundled Helm with a cached bootstrap model:
   - create `scripts/lib/k8s-tools.mjs`
   - make it the single owner of Helm resolution

4. Helm resolution order must be:
   1. `RIVET_K8S_HELM_BIN`
   2. system `helm`/`helm.exe`
   3. cached downloaded Helm in `.data/tools/helm/<version>/<platform>/`

5. Use this cache path:
   - `.data/tools/helm/v3.20.1/<platform>/...`
   - keep the version pinned in code, not in docs prose only
   - verify the downloaded archive before unpacking it; the helper should validate the pinned release against the official checksum for that version instead of trusting the download blindly

6. Add `scripts/ensure-k8s-tools.mjs`:
   - explicit bootstrap entrypoint
   - installs cached Helm when required
   - no repo-tracked output
   - this is the only script allowed to download Helm; regular launcher and verification flows may use a cached copy but should not silently download tools during `config` or `verify`

7. Add root script:
   - `setup:k8s-tools`

8. Update:
   - `scripts/dev-kubernetes.mjs`
   - `scripts/verify-kubernetes.mjs`
   so both use `scripts/lib/k8s-tools.mjs`
   - when no explicit, system, or cached Helm is available, fail with an actionable message pointing to `npm run setup:k8s-tools` or `RIVET_K8S_HELM_BIN`

9. Update `.gitignore` if needed so the tool cache is explicitly ignored under `.data/tools/`
   - `.data/` is already ignored today, so only add a narrower rule if that broad ignore changes later

**Acceptance result**

- Git no longer tracks platform binaries for Helm or Kind
- Windows users can still run Kubernetes verification without manual Helm setup
- system Helm and env overrides still work first
- launcher and verification commands never surprise-download tooling; they either use an existing cached Helm or fail with an explicit setup instruction

### 3. Standardize the package-manager story without workspaces

**Goal**

Make the repo honest about how it is actually used.

**Implementation**

1. Standardize on `npm` as the repo command surface.
   - keep `npm run ...` as the documented and supported entrypoint
   - do not introduce npm/pnpm/yarn workspaces

2. Remove the misleading root `packageManager: yarn...` declaration from `package.json`.
   - the root repo does not operate as a Yarn workspace monorepo
   - keep `corepack yarn --cwd rivet ...` only where it is explicitly for upstream Rivet

3. Keep per-package lockfiles:
   - `wrapper/api/package-lock.json`
   - `wrapper/web/package-lock.json`
   - `ops/proxy-bootstrap/package-lock.json` until that package moves
   - after the move, keep the lockfile with the moved package

4. Do not add a root `package-lock.json`.
   - the root package is still launcher-only
   - it is not becoming a workspace root in this pass

5. Improve package metadata where it is too thin:
   - add a description and stable package name to `wrapper/shared/package.json`
   - audit `wrapper/executor/package.json` and only rename/reword it if the current `hosted-rivet-executor-deps` package identity still reads as a throwaway dependency bucket after the repo cleanup
   - keep these private

6. Update `docs/development.md` and `README.md` so the install/runtime model is explicit:
   - root repo uses npm launcher commands
   - upstream `rivet/` still uses Yarn internally
   - no workspace manager is being introduced

**Acceptance result**

An engineer no longer gets conflicting signals about whether this is an npm repo, a Yarn repo, or a workspace monorepo.

### 4. Clean up the deployment/runtime boundary

**Goal**

Make it obvious which files are deployment assets and which files are real runtime/bootstrap code.

**Implementation**

1. Keep the current top-level deployment domains:
   - keep `charts/`
   - keep `image/`
   - keep `ops/`

2. Reorganize `ops/` into explicit subdomains:
   - `ops/compose/`
   - `ops/docker/`
   - `ops/nginx/`
   - keep `ops/` for deployment-only assets; do not move proxy-image runtime assets into it just for symmetry

3. Move these files into `ops/compose/`:
   - `docker-compose.yml`
   - `docker-compose.dev.yml`
   - `docker-compose.managed-services.yml`

4. Move these files into `ops/docker/`:
   - `Dockerfile.api`
   - `Dockerfile.executor`
   - `Dockerfile.web`

5. Move these Compose-only proxy templates into `ops/nginx/`:
   - `nginx.conf` -> `default.conf.template`
   - `nginx.dev.conf` -> `default.dev.conf.template`
   - keep them explicitly Compose-scoped; they are not the same asset as `image/proxy/default.conf.template`

6. Deduplicate shared proxy assets instead of moving the duplicates wholesale:
   - keep `image/proxy/ui-gate-prompt.html` as the single canonical prompt asset
   - move `ops/normalize-workflow-paths.sh` to `image/proxy/normalize-workflow-paths.sh`
   - update Compose bind mounts and `image/proxy/Dockerfile` to consume those canonical proxy-image assets
   - delete the now-redundant `ops/ui-gate-prompt.html`

7. Move runtime/bootstrap code out of `ops/`:
   - create `wrapper/bootstrap/proxy-bootstrap/`
   - move:
     - `bootstrap.mjs`
     - `config.mjs`
     - `runtime-libraries-sync.mjs`
     - `state.mjs`
     - `sync.mjs`
     - `package.json`
     - `package-lock.json`
   - reason: this is runtime Node bootstrap logic imported by API/executor processes, not deployment-only glue

8. Move executor build logic out of `ops/`:
   - create `wrapper/executor/build/`
   - move `ops/bundle-executor.cjs` there
   - reason: this is executor packaging/build logic, not deployment layout

9. Move the compatibility/update helper out of `ops/`:
   - move `ops/update-check.sh` to `scripts/update-check.sh`
   - reason: it is a repository maintenance script for upstream `rivet/` changes, not a deployment asset

10. Update every reference to the moved paths:
   - `image/api/Dockerfile`
   - `image/executor/Dockerfile`
   - `image/proxy/Dockerfile`
   - `ops/docker/Dockerfile.api`
   - `ops/docker/Dockerfile.executor`
   - `ops/compose/*.yml`
   - `scripts/dev-docker.mjs`
   - `scripts/prod-docker.mjs`
   - `scripts/dev-kubernetes.mjs`
   - `wrapper/api/src/tests/runtime-library-cleanup.test.ts`
   - `wrapper/api/src/tests/phase4-static-contract.test.ts`
   - docs
   - CI as needed
   - explicitly account for Compose-relative path changes after moving the files under `ops/compose/`:
     - `env_file` paths
     - `build.dockerfile` paths
     - bind mounts such as `./proxy-bootstrap`, `./nginx.conf`, `./normalize-workflow-paths.sh`, and `./ui-gate-prompt.html`
     - default host-path values such as `${RIVET_WORKFLOWS_HOST_PATH:-../workflows}`

11. Keep proxy-image assets split from Compose-only proxy templates on purpose:
   - keep `image/proxy/nginx.conf` as the image-global Nginx config
   - keep `image/proxy/default.conf.template` as the containerized proxy template
   - keep `ops/nginx/default.conf.template` and `ops/nginx/default.dev.conf.template` as Compose-only templates
   - do not try to force the image and Compose proxy templates into one file; they encode different upstream topology assumptions

12. Do not rename `image/` in this pass.
   - it is awkwardly singular, but changing that now is not worth the repo-wide churn
   - document its role instead: canonical image build definitions used by CI and Kubernetes/local image builds

**Acceptance result**

- `ops/` contains deployment assets only
- shared proxy assets live once under `image/proxy/`, while Compose-only proxy templates live under `ops/nginx/`
- runtime bootstrap code lives under `wrapper/`
- executor build logic lives with executor code
- the `ops/` tree becomes readable at a glance

### 5. Add a lightweight repo-structure guardrail

**Goal**

Prevent the repo from drifting back into root clutter and misplaced runtime code.

**Implementation**

1. Add `scripts/verify-repo-structure.mjs`.

2. It should assert:
   - tracked `.tools/` artifacts are absent from Git index; do this via `git ls-files` rather than raw filesystem checks so local caches do not fail the verification
   - required top-level authored directories exist
   - tracked root Markdown files match the approved allowlist
   - `ops/` contains only deployment-oriented files and subdirectories
   - `wrapper/bootstrap/proxy-bootstrap/` exists and is the only location for that runtime bootstrap package
   - `wrapper/executor/build/bundle-executor.cjs` exists
   - expected `ops/compose`, `ops/docker`, and `ops/nginx` paths exist
   - `ops/update-check.sh` no longer exists
   - `ops/ui-gate-prompt.html` no longer exists
   - canonical proxy assets exist under `image/proxy/`

3. Add root script:
   - `verify:repo-structure`

4. Run it in CI before image building.
   - add it to `.github/workflows/build-images.yml`
   - keep it separate from application build/test logic

**Acceptance result**

Future repo-structure regressions become visible immediately instead of silently accumulating.

### 6. Documentation and contributor experience

**Goal**

Make the improved structure discoverable and self-explanatory.

**Implementation**

1. Update `README.md`:
   - repository map
   - root working docs
   - launcher/tooling expectations
   - where deployment assets live

2. Add `docs/repo-structure.md`:
   - authoritative structure reference

3. Update `docs/development.md`:
   - npm/no-workspaces rule
   - `setup:k8s-tools`
   - `verify:repo-structure`
   - where runtime bootstrap code lives
   - `ops/compose`, `ops/docker`, `ops/nginx` roles

4. Update `docs/architecture.md`:
   - mention `wrapper/bootstrap/` as runtime/bootstrap code, not deployment code

5. Update `docs/kubernetes.md`:
   - explain Helm bootstrap expectations for local Windows users
   - keep `RIVET_K8S_HELM_BIN` override documented

6. Update `docs/access-and-routing.md` and any other docs/comments that still describe:
   - `ops/proxy-bootstrap`
   - flat `ops/`
   - bundled `.tools/helm.exe`
   - `ops/ui-gate-prompt.html`
   - old Compose-relative paths under `ops/`

**Acceptance result**

A contributor should not need to infer the repo structure from Dockerfiles and scripts.

## Test Cases And Scenarios

### Structure verification

Run after the structure cleanup:

```bash
npm run verify:repo-structure
```

Must prove:

- tracked `.tools/` binaries are gone from the Git index
- root Markdown policy is enforced
- `ops/compose`, `ops/docker`, and `ops/nginx` exist
- runtime bootstrap code is not under `ops/`
- `ops/update-check.sh` is gone
- `image/proxy/ui-gate-prompt.html` and `image/proxy/normalize-workflow-paths.sh` are the canonical shared proxy assets

### Launcher verification

Run after path moves:

```bash
npm run dev:docker:config
npm run prod:docker:config
npm run verify:kubernetes
npm run dev:kubernetes-test:config
```

Must prove:

- Docker launcher scripts resolve the moved Compose and Dockerfile paths
- Compose renders successfully with the new relative `env_file`, bind-mount, and host-path defaults from `ops/compose/`
- Kubernetes scripts resolve Helm via env override, PATH, or cached bootstrap
- no path references still point at removed locations

### Build and packaging verification

Run after moving bootstrap/build code:

```bash
npm --prefix wrapper/api run build
npm --prefix wrapper/web run build
```

If container paths changed, also verify:

```bash
docker build -f image/api/Dockerfile .
docker build -f image/executor/Dockerfile .
docker build -f image/web/Dockerfile .
docker build -f image/proxy/Dockerfile .
```

Must prove:

- moved bootstrap package still installs correctly in image builds
- moved executor bundler still produces the executor bundle correctly
- proxy image still builds after moving `normalize-workflow-paths.sh` and deduplicating the UI-gate prompt asset

### CI verification

The build-images workflow must still pass with updated paths:

- `.github/workflows/build-images.yml` points at the correct image Dockerfiles
- the new `verify:repo-structure` step passes before image builds start

### Windows/local tool bootstrap scenarios

Validate these explicitly:

1. Windows machine with no Helm on PATH:
   - `npm run setup:k8s-tools`
   - `npm run verify:kubernetes`
   - expected: cached Helm is used successfully

2. Windows machine with `RIVET_K8S_HELM_BIN` set:
   - expected: override wins, no bootstrap download

3. Machine with system Helm already installed:
   - expected: system Helm wins, no cache bootstrap required

4. Clean repo with no `kind.exe`:
   - expected: no launcher failure, because Kind is not part of the active contract

5. Machine with no Helm on PATH and no cached tool yet:
   - `npm run verify:kubernetes`
   - expected: actionable failure that points to `npm run setup:k8s-tools` or `RIVET_K8S_HELM_BIN`; no implicit download during verification

## Explicit Assumptions And Defaults

- Scope is **medium**, not conservative and not aggressive.
- Keep active working docs at the repo root.
- Standardize on `npm` as the repo command surface.
- Do **not** migrate to workspaces in this pass.
- Do **not** move `charts/`, `image/`, or `wrapper/` to a new top-level umbrella directory.
- Do **not** rename `image/` in this pass.
- Remove tracked helper binaries from Git; replace only Helm with cached bootstrap logic.
- Do **not** auto-download Helm during ordinary launcher or verification commands; bootstrap is explicit via `setup:k8s-tools`, while launchers may consume a cached copy if it already exists.
- Do **not** replace `kind.exe` with new bootstrap logic, because it is not used by the current launchers.
- Keep proxy-image assets and Compose-only proxy templates as separate concerns. Deduplicate only the truly shared proxy assets.
- Preserve all existing user-facing root commands; new commands are additive.
- Preserve all external product behavior and deployment contracts.
