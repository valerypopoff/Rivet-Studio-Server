# Plan: Pre-built Docker Images via GitHub Actions + ghcr.io

## Context

Currently, `npm run prod` triggers `docker compose up --build`, which compiles everything **on the user's VPS**:
- Downloads ~500MB of yarn/npm packages inside Docker
- Builds rivet-core and trivet from TypeScript source
- Runs a Vite build requiring 2GB heap for the frontend (~30MB output)
- Bundles the executor with esbuild

This takes 10-20+ minutes and peaks at 2-3GB RAM. On a 4GB VPS this can OOM-kill or swap-thrash. **The entire build is deterministic** — every user builds the exact same output from the same source. There's no reason to repeat this work on every VPS.

## Solution: Ship pre-built Docker images

Move all compilation to GitHub Actions (7GB RAM, free for public repos) and push ready-to-run images to GitHub Container Registry (ghcr.io). Users just pull and start.

**Before (current):**
```
git clone → npm run setup:rivet → npm run prod
                                   ↓
                    docker compose up --build (10-20 min, 2-3GB RAM)
                    ├── yarn install rivet deps
                    ├── build rivet-core, trivet
                    ├── npm install wrapper deps
                    ├── vite build (2GB heap!)
                    ├── esbuild executor bundle
                    └── npm ci api deps
```

**After:**
```
git clone → npm run prod
              ↓
   docker compose pull + up (1-2 min, <200MB RAM)
   ├── pull ghcr.io/.../web:latest    (~50MB compressed)
   ├── pull ghcr.io/.../api:latest    (~30MB compressed)
   └── pull ghcr.io/.../executor:latest (~30MB compressed)
```

## Files to create/modify

### 1. Create `.github/workflows/build-images.yml`

GitHub Actions workflow that:
- **Triggers on**: push to `main`, version tags (`v*`), manual dispatch
- **Steps**:
  1. Checkout repo
  2. Run `npm run setup:rivet` to download upstream Rivet source
  3. Set up Docker Buildx (for multi-arch)
  4. Log in to ghcr.io using `GITHUB_TOKEN` (automatic, no secrets needed)
  5. Build & push 3 images in parallel:
     - `ghcr.io/valerypopoff/cloud-hosted-rivet-wrapper/web`
     - `ghcr.io/valerypopoff/cloud-hosted-rivet-wrapper/api`
     - `ghcr.io/valerypopoff/cloud-hosted-rivet-wrapper/executor`
  6. Tag with: `latest`, git SHA short, version tag (if applicable)
  7. Platforms: `linux/amd64,linux/arm64` (covers most VPS providers including Oracle free tier ARM)
- Uses GitHub Actions cache for Docker layers to speed up subsequent builds

### 2. Modify `ops/docker-compose.yml`

Add `image:` directives to all 3 services alongside existing `build:` sections:

```yaml
web:
  image: ghcr.io/valerypopoff/cloud-hosted-rivet-wrapper/web:latest
  build:
    # ... existing build config unchanged ...
```

When both `image:` and `build:` are present:
- `docker compose pull` → pulls the pre-built image
- `docker compose up -d` → uses pulled image (no build)
- `docker compose up -d --build` → builds locally (ignoring image)

This is 100% backwards-compatible.

### 3. Modify `scripts/prod-docker.mjs`

Change the default `prod` action from:
```js
prod: [`${composeBase} up -d --build --wait --wait-timeout ${waitTimeoutSeconds}`]
```
to:
```js
prod: [
  `${composeBase} pull`,
  `${composeBase} up -d --wait --wait-timeout ${waitTimeoutSeconds}`
]
```

And update `recreate` similarly. The existing `build` and `up` actions stay as-is for local builds.

Also: remove `COMPOSE_PARALLEL_LIMIT=1` for pull mode (parallel pulls are fine, only parallel builds are RAM-intensive).

### 4. Add `npm run prod:local` script in root `package.json`

New script for users who want to build locally (e.g., for customization):
```json
"prod:local": "node scripts/prod-docker.mjs prod-local"
```

The `prod-local` action in the script would use the current `--build` flag behavior.

### 5. Update `.env.example` with documentation

Add a comment explaining the image-based approach and how to override for local builds.

## Impact

| Metric | Before | After |
|--------|--------|-------|
| RAM during deploy | 2-3 GB peak | <200 MB |
| Deploy time (first run) | 10-20 min | 1-2 min |
| Deploy time (update) | 5-15 min | <1 min |
| Disk during build | ~2 GB temp | ~150 MB images |
| Min VPS RAM needed | 4 GB (barely) | 1 GB (for running) |

## Verification

1. Push to main → verify GitHub Actions builds and pushes all 3 images to ghcr.io
2. On a clean VPS: `git clone`, configure `.env`, `npm run prod` → verify it pulls images and starts (no build)
3. Verify `npm run prod:local` still builds locally (existing behavior)
4. Verify `npm run prod:recreate` pulls fresh images and recreates containers
