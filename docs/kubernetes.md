# Kubernetes

This repo supports one Kubernetes topology today:

- `proxy`: scalable
- `web`: fixed at `1` in the current endpoint-heavy recommended shape
- `backend`: singleton
- `execution`: scalable

That split is intentional. The singleton `backend` owns:

- `/api/*`
- `/ui-auth`
- `${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}`
- `/ws/latest-debugger`

The `execution` Deployment owns:

- `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}`
- `/internal/workflows/:endpointName`

Do not scale `backend` horizontally in the current chart shape. Latest execution and `/ws/latest-debugger` are still process-local control-plane features.

## Scaling model

Scaling in this chart is per Deployment or StatefulSet, not in fixed pod pairs.

- a new `execution` pod is only another execution-plane API pod
- a new `proxy` pod is only another nginx proxy pod
- a new `web` pod is only another dashboard shell pod
- the `backend` StatefulSet stays at one pod because the current control-plane and latest-debugger behavior is still process-local

That means rising endpoint demand should usually add `execution` pods first. `proxy` should stay redundant and may also scale, but it does not need to grow one-for-one with `execution`.

Recommended operator mental model:

- scale `execution` for workflow endpoint throughput
- keep `proxy` redundant so ingress and websocket termination do not become a single bottleneck
- keep `web=1` when the dashboard is only used by one operator and temporary UI hiccups are acceptable
- keep `backend=1` until the process-local control-plane constraints are removed architecturally

Typical endpoint-heavy production shape:

- `proxy`: `2` to `5`
- `execution`: `2` to `10`
- `web`: `1`
- `backend`: `1`

Do not treat that as a forced ratio. `execution=8` with `proxy=2` can be correct. The tiers scale independently.

## Autoscaling prerequisites

The current HPAs are CPU-based:

- `proxy` HPA targets the `proxy` Deployment
- `execution` HPA targets the `execution` Deployment

Before relying on those HPAs in production, set real CPU and memory requests in the chart values for at least:

- `resources.proxy`
- `resources.execution`

Without CPU requests, CPU-utilization HPA behavior is not trustworthy. The chart shape is ready for autoscaling, but operators should treat resource sizing as a required part of the production handoff.

## Local rehearsal

Use the local Kubernetes launcher when you want the closest practical browser-level rehearsal of the real chart:

```bash
npm run dev:kubernetes-test
```

Current behavior:

- builds local `proxy`, `web`, `api`, and `executor` images
- deploys the real Helm chart into a dedicated namespace
- keeps `backend=1`
- keeps `web=1`
- scales `proxy` and `execution`
- port-forwards the proxy service for local browser access

The launcher expects:

- `RIVET_STORAGE_MODE=managed`
- `RIVET_DATABASE_MODE=managed`
- external managed Postgres
- external S3 or S3-compatible storage

The local overlay at [charts/overlays/local-kubernetes.yaml](/d:/Programming/Self-hosted-rivet/charts/overlays/local-kubernetes.yaml) is not a standalone values file. It is meant to be merged with the generated values file from `scripts/dev-kubernetes.mjs`.

Useful commands:

- `npm run dev:kubernetes-test:config`
- `npm run dev:kubernetes-test:ps`
- `npm run dev:kubernetes-test:logs`
- `npm run dev:kubernetes-test:down`

## Production handoff

The production starting point is [charts/overlays/prod.yaml](/d:/Programming/Self-hosted-rivet/charts/overlays/prod.yaml).

Before DevOps installs it, they must replace or confirm:

- `images.*.repository`
- `clusterDomain` if the cluster does not use `cluster.local`
- ingress hostnames and DNS annotations
- Vault role, secret path, and dotenv template if Vault is used
- managed Postgres secret wiring
- object-storage bucket, region, endpoint, and secret wiring
- `auth.keySecretName` or equivalent Vault-provided `RIVET_KEY`

The production contract today is:

- `workflowStorage.backend=managed`
- `runtimeLibraries.backend=managed`
- `replicaCount.proxy=2`
- `replicaCount.web=1`
- `replicaCount.backend=1`
- `replicaCount.execution=2`
- `autoscaling.proxy.enabled=true`
- `autoscaling.web.enabled=false`
- `autoscaling.backend.enabled=false`
- `autoscaling.execution.enabled=true`
- `env.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH=/workflows`
- `env.RIVET_LATEST_WORKFLOWS_BASE_PATH=/workflows-latest`
- `clusterDomain=cluster.local` unless the cluster DNS suffix is different
- `env.RIVET_PROXY_RESOLVER` must be set for in-cluster nginx DNS resolution
- control-plane runtime-library reporting should stay at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=none` with the job worker enabled there
- execution-plane runtime-library reporting should stay at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint` with `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=false`
- executor runtime-library reporting should stay at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=editor`
- `proxy` and `execution` scale independently; they are not a tied pair
- production resource requests should be defined before relying on CPU-based HPA decisions

Chart-maintainer note:

- backend/execution chart reuse is intentionally shallow
- shared env and pod fragments live in `_env.tpl` and `_pod.tpl`
- API containers mount app-data at `/data/rivet-app`, while the executor keeps its app-data mount at `/home/rivet/.local/share/com.ironcladapp.rivet` because it still expects the Rivet desktop storage layout
- `proxy` and `web` remain mostly explicit so rendered pod shape stays operator-readable

## Repo-local verification

Run this before handing the repo to DevOps:

```bash
npm run verify:kubernetes
```

That command proves:

- the local rehearsal values path still renders cleanly
- the static Kubernetes contract tests still pass
- the production overlay still lint-renders with concrete image repository overrides

For a live-cluster local check, also run:

```bash
npm run dev:kubernetes-test
```

Then validate:

- the proxy URL opens successfully
- `/api/config` returns the expected published/latest base paths
- published workflow runs succeed through the scaled `execution` Deployment
- latest workflow runs still debug through the singleton `backend`

## Operator checklist

- scale `execution` for endpoint demand
- keep `proxy` redundant and autoscaled because all endpoint traffic still crosses it
- keep `web` fixed at `1` unless real dashboard traffic becomes significant
- keep the control plane conservative and do not scale `backend`
- do not couple `proxy` and `execution` replica counts mechanically; let each tier scale for its own pressure
- set concrete CPU and memory requests for `proxy` and `execution` before treating HPA as production-ready
- keep the same `RIVET_KEY` available to both `proxy` and the API workloads
- route `${RIVET_LATEST_WORKFLOWS_BASE_PATH}` and `/ws/latest-debugger` to the singleton control plane
- route `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` to the execution plane
- keep runtime-library job ownership on the singleton control plane and keep execution replicas in sync-only mode
- treat the local launcher as a rehearsal wrapper around the real chart, not a separate deployment contract
