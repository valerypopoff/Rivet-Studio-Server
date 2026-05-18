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

If Helm is not already on PATH, install the pinned cached copy first:

```bash
npm run setup:k8s-tools
```

Current behavior:

- builds local `proxy`, `web`, `api`, and `executor` images
- deploys the real Helm chart into a dedicated namespace
- uses the explicit `RIVET_K8S_CONTEXT` when set
- otherwise uses the current `kubectl` context when one exists
- otherwise falls back to the `minikube` context automatically when the Minikube CLI is installed
- keeps `backend=1`
- keeps `web=1`
- scales `proxy` and `execution`
- port-forwards the proxy service for local browser access
- on Docker Desktop, imports freshly built images into the cluster node containers
- on Minikube, loads freshly built images with `minikube image load --daemon=true`
- on Minikube-backed `dev`, `up`, and `recreate`, starts the target Minikube profile automatically when needed

The launcher expects:

- `RIVET_STORAGE_MODE=managed`
- `RIVET_DATABASE_MODE=managed`
- external managed Postgres
- external S3 or S3-compatible storage

The local overlay at [charts/overlays/local-kubernetes.yaml](../charts/overlays/local-kubernetes.yaml) is not a standalone values file. It is meant to be merged with the generated values file from `scripts/dev-kubernetes.mjs`.

Managed runtime-library startup now serializes its shared Postgres schema initialization behind a PostgreSQL advisory lock. That avoids first-boot deadlocks when the control-plane API and execution/editor processes start against the same managed database at the same time.

Useful commands:

- `npm run dev:kubernetes-test:config`
- `npm run dev:kubernetes-test:ps`
- `npm run dev:kubernetes-test:logs`
- `npm run dev:kubernetes-test:down`

Useful Minikube-specific overrides:

- `RIVET_K8S_CONTEXT=minikube`
- `RIVET_K8S_CLUSTER_PROVIDER=minikube`
- `RIVET_K8S_MINIKUBE_PROFILE=minikube`
- `RIVET_K8S_MINIKUBE_BIN=/path/to/minikube`

Helm resolution order for the local launcher and `npm run verify:kubernetes` is:

1. `RIVET_K8S_HELM_BIN`
2. system `helm`
3. cached Helm under `.data/tools/helm/`

If none of those exist, the launcher/verification flow fails with an explicit instruction to run `npm run setup:k8s-tools`.

## DevOps handoff map

This repo is already shaped like a Kubernetes application, but it is not the single-container sample chart shape. Treat it as a custom four-workload app:

| DevOps expectation | This repo |
|---|---|
| Root `image/` directory | Present. It contains four runtime images: `image/proxy/Dockerfile`, `image/web/Dockerfile`, `image/api/Dockerfile`, and `image/executor/Dockerfile`. |
| Application user `uid/gid=10001` | Present. Runtime images and chart security contexts run workloads as `10001:10001`. |
| Environment overlays | Present under [charts/overlays](../charts/overlays). If your GitLab template requires `deploy/overlays`, point that wrapper at these values or copy environment overrides from here; do not replace the custom chart with a generic single-service chart. |
| Helm chart | Present under [charts](../charts). It renders `proxy`, `web`, singleton `backend`, scalable `execution`, services, ingress, HPAs, Vault annotations, and validation guards. |
| CI image build | Current publishing is GitHub Actions at [.github/workflows/build-images.yml](../.github/workflows/build-images.yml). If deploying from GitLab CI, create equivalent jobs for all four Dockerfiles or reuse the published GHCR images. |
| Vault AppRole | The chart uses Vault Injector annotations through `vault.role`, `vault.authPath`, `vault.secretPath`, and `vault.dotenvTemplate`. The containers source `/vault/dotenv` during startup. |

Do not deploy this app with a generic one-Deployment chart unless that chart can faithfully express the four workload roles and their routing:

- public browser traffic enters `proxy`
- dashboard/editor assets come from `web`
- `/api/*`, latest workflow execution, and `/ws/latest-debugger` go to singleton `backend`
- published workflow endpoint traffic goes to scalable `execution`
- the internal editor Node executor websocket goes to the executor sidecar in the singleton `backend`

If company delivery requires a root `.gitlab-ci.yml`, treat the current GitHub workflow as the image-publish reference and the Helm values in this document as the deploy reference. The GitLab pipeline must either:

- reuse the published GHCR images and only run Helm deploy stages, or
- build and push four images, one per Dockerfile, then pass the resulting repositories and one shared tag through `images.*`

Environment-specific Vault AppRoles from CI should line up with the chart values:

- CI/deploy credentials belong in the GitLab pipeline template
- the pod runtime Vault role belongs in `vault.role`
- the Vault auth mount, when not default, belongs in `vault.authPath`
- the secret rendered into `/vault/dotenv` belongs in `vault.secretPath`

Do not use `vault.roleIdSecretName`; that value is retired and the chart rejects it during render.

## Production handoff

The production starting point is [charts/overlays/prod.yaml](../charts/overlays/prod.yaml).

Before DevOps installs it, they must replace or confirm:

- `images.*.repository` and `images.*.tag`
- `clusterDomain` if the cluster does not use `cluster.local`
- ingress hostnames and DNS annotations
- Vault role, secret path, and dotenv template if Vault is used
- managed Postgres secret wiring
- object-storage bucket, region, endpoint, and secret wiring
- `auth.keySecretName` or equivalent Vault-provided `RIVET_KEY`

The chart defaults deliberately use `example.invalid/...` image repositories and the templates fail validation until those placeholders are replaced. This keeps production installs from silently using stale or accidental images.

The Rivet 2 wrapper image pipeline publishes the default GitHub Container Registry repositories as:

```yaml
images:
  proxy:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/proxy
    tag: latest
  web:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/web
    tag: latest
  api:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/api
    tag: latest
  executor:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/executor
    tag: latest
```

The `latest` tag is produced from pushes to `main-rivet2`; commit SHA and tag-derived image tags are also produced by the same workflow.
For production, prefer pinning all four image tags to the same published commit SHA or release tag instead of leaving them on `latest`.
If the GHCR packages are private, configure `imagePullSecrets`; public packages should pull anonymously.

Current published image platforms:

- `proxy`, `web`, and `api`: `linux/amd64` and `linux/arm64`
- `executor`: `linux/amd64`

Run the production chart on `linux/amd64` nodes unless the executor image is rebuilt for another platform.

### Environment values skeleton

Use this as the shape for an environment override file, whether your pipeline stores it as `charts/overlays/prod.yaml`, `charts/overlays/test.yaml`, or a company-standard `deploy/overlays/<env>.yaml` wrapper:

```yaml
imagePullSecrets: []

images:
  proxy:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/proxy
    tag: <published-tag>
  web:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/web
    tag: <published-tag>
  api:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/api
    tag: <published-tag>
  executor:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/executor
    tag: <published-tag>

ingress:
  enabled: true
  className: <ingress-class>
  host: <rivet-hostname>
  externalDNSHostname: <rivet-hostname>
  tlsSecretName: <tls-secret-name>
  annotations: {}

vault:
  enabled: true
  role: <vault-approle-name>
  authPath: <vault-auth-path>
  secretPath: <vault-secret-data-path>
  tlsSkipVerify: false
  caSecretName: <vault-ca-secret>
  caCertPath: /vault/tls/ca.crt
  dotenvFileName: dotenv
  dotenvTemplate: |
    {{- with secret "<vault-secret-data-path>" -}}
    {{- range $key, $value := .Data.data }}
    {{ $key }}={{ $value | toJSON }}
    {{- end }}
    {{- end }}

postgres:
  mode: managed
  host: <postgres-host>
  port: 5432
  database: <postgres-database>
  username: <postgres-username>
  sslMode: require
  # If Vault is disabled, also set passwordSecretName/passwordSecretKey

objectStorage:
  endpoint: <s3-or-compatible-endpoint>
  bucket: <bucket-name>
  region: <bucket-region>
  prefix: workflows/
  forcePathStyle: false
  # If Vault is disabled, also set accessKeySecretName and secretKeySecretName

auth:
  # If Vault is disabled, set keySecretName/keySecretKey.
  # If Vault is enabled, /vault/dotenv may provide RIVET_KEY instead.
  keySecretName: ""

resources:
  proxy:
    requests:
      cpu: <value>
      memory: <value>
    limits:
      cpu: <value>
      memory: <value>
  execution:
    requests:
      cpu: <value>
      memory: <value>
    limits:
      cpu: <value>
      memory: <value>
```

The sample `service.type: NodePort` / single `service.targetPort` pattern from simple apps does not apply here. This chart creates component services internally, keeps them as `ClusterIP`, and routes ingress to the `proxy` service.

If you are adapting a standard single-app overlay, do not expect these sample keys to do anything until the chart explicitly supports them:

- `metrics`
- `writableDirs`
- `sidecar`
- `probes`
- `strategy`
- `topologySpreadConstraints`
- `pdb`
- single-service `hpa`

Use this chart's existing `autoscaling.proxy`, `autoscaling.execution`, `resources.*`, `ingress`, `vault`, and component `service.*` values instead. Add new chart support intentionally if the cluster standard requires one of the unsupported knobs.

### Vault dotenv contract

All runtime images source `/vault/dotenv` at startup. They also accept the Vault Injector default fallback path `/vault/secrets/<dotenvFileName>`.

When Vault is enabled, the dotenv file should provide the sensitive values that should not live directly in Helm values:

```dotenv
RIVET_KEY=<shared-random-secret>
RIVET_DATABASE_PASSWORD=<postgres-password>
RIVET_STORAGE_ACCESS_KEY_ID=<object-storage-access-key-id>
RIVET_STORAGE_ACCESS_KEY=<object-storage-secret-access-key>
```

You may provide `RIVET_DATABASE_CONNECTION_STRING` instead of `RIVET_DATABASE_PASSWORD`, but keep the non-secret `postgres.host`, `postgres.database`, and `postgres.username` values in the Helm values because chart validation uses them to catch incomplete managed-storage configuration.

`RIVET_KEY` must be available to both the proxy and API workloads. It is used for trusted proxy-to-API identity and for optional public route/UI access checks.

### Direct Helm commands

Use these commands as the raw Helm equivalent of a CI deploy step:

```bash
helm lint ./charts \
  -f charts/overlays/prod.yaml \
  -f path/to/environment-values.yaml

helm template rivet ./charts \
  --namespace your-namespace \
  -f charts/overlays/prod.yaml \
  -f path/to/environment-values.yaml

helm upgrade --install rivet ./charts \
  --namespace your-namespace \
  --create-namespace \
  -f charts/overlays/prod.yaml \
  -f path/to/environment-values.yaml
```

With release name `rivet`, the default Kubernetes object names are prefixed as `rivet-rivet-*` because the chart name is also `rivet`. Set `fullnameOverride: rivet` in the environment values if the desired object prefix is just `rivet-*`.

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
- API containers mount app-data at `/data/rivet-app`, while the executor keeps its app-data mount at `/home/rivet/.local/share/com.valerypopoff.rivet2` because it still expects the Rivet desktop storage layout
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
