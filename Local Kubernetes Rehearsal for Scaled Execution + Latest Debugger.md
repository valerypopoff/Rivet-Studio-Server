# Local Kubernetes Rehearsal for Scaled Execution + Latest Debugger

## Summary

Use Docker Desktop Kubernetes, deploy the app through the real Helm chart, keep the control-plane backend at `1`, keep the low-traffic web tier at `1`, and run the endpoint-facing scalable deployments at `2` replicas:

- `proxy=2`
- `web=1`
- `execution=2`
- `backend=1`

For the most authentic local rehearsal, keep the app itself in Kubernetes and point it at the same kind of external managed services you intend to use for real deployment:

- external managed Postgres
- external S3 or S3-compatible object storage

That keeps routing, proxying, `/ws/latest-debugger`, control-plane vs execution-plane split, TLS, auth, and managed-storage behavior all close to the real deployment shape.

Fast path:

- set the required managed-service envs in `.env` or `.env.dev`
- run `npm run dev:kubernetes-test`
- open `http://127.0.0.1:8080`
- when done, run `npm run dev:kubernetes-test:down`

Current local state check:

- Docker Desktop Kubernetes should be enabled and healthy
- `kubectl` should point at `docker-desktop`
- Helm should be installed in your shell
- Docker Desktop may still show `0` app containers in the normal Containers view because the workloads run as Kubernetes pods inside the local node container; use `kubectl` or `npm run dev:kubernetes-test:ps` for the real status

## Important public APIs / interfaces / types

No repo contract changes are needed. This rehearsal is specifically proving the deployed behavior of:

- `GET /api/config`
- `POST /workflows/:endpointName`
- `POST /workflows-latest/:endpointName`
- `WS /ws/latest-debugger`

Important topology rule being exercised:

- `backend` stays singleton
- `execution` is the endpoint-run scale target
- `proxy` and `web` may also scale
- latest runs plus `/ws/latest-debugger` stay on the singleton backend

## Recommended local topology

### In Kubernetes

- `proxy`: 2 replicas
- `web`: 1 replica
- `backend`: 1 replica
- `execution`: 2 replicas

### Outside Kubernetes

Use your real managed services:

- external managed Postgres
- external S3 or S3-compatible object storage

Optional fallback:

- if you only want a disposable local storage layer, you can still use `ops/docker-compose.managed-services.yml`
- that fallback is useful for quick rehearsal, but it is less authentic than the real managed-services path

## One-command workflow

The repo now includes a launcher that automates the local rehearsal:

```bash
npm run dev:kubernetes-test
```

What it does:

1. ensures the local images are built from the current workspace
2. imports those local images into the Docker-backed local Kubernetes node runtime when needed
3. generates a local Kubernetes values file under `.data/kubernetes-test/`
4. creates or updates the Kubernetes namespace and required secrets
5. deploys the real Helm chart with the local Kubernetes overlay
6. starts a `kubectl port-forward` for the proxy service
7. prints the local browser URL

Operational note:

- the launcher targets `RIVET_K8S_CONTEXT` explicitly and does not rewrite your global `kubectl` current-context
- if your cluster DNS suffix is not `cluster.local`, set `RIVET_K8S_CLUSTER_DOMAIN` before launching
- the proxy resolver env may stay as a Kubernetes service hostname such as `kube-dns.kube-system.svc.cluster.local`; the proxy entrypoint resolves it to the DNS server IPs nginx expects at startup

Related commands:

```bash
npm run dev:kubernetes-test:recreate
npm run dev:kubernetes-test:config
npm run dev:kubernetes-test:ps
npm run dev:kubernetes-test:logs
npm run dev:kubernetes-test:down
```

The rest of this document is the transparent manual equivalent, which is still useful for debugging the launcher or handing the workflow to DevOps.

## Step-by-step runbook

### 1. Preflight the local environment

From the repo root:

```bash
npm run setup
docker version
kubectl version --client
helm version
docker desktop kubernetes status
kubectl config get-contexts
kubectl config current-context
```

Expected before you continue:

- Docker works
- Helm is installed
- `docker desktop kubernetes status` reports Kubernetes `running`
- `kubectl config current-context` is `docker-desktop`

If Docker Desktop Kubernetes is still disabled, enable it in Docker Desktop settings first.

Then switch context if needed:

```bash
kubectl config use-context docker-desktop
kubectl get nodes
```

### 2. Collect the managed-service inputs you will actually use

Before installing the chart, have these ready:

- one shared `RIVET_KEY` value for proxy-to-api trust
- one external Postgres connection string
- one object-storage access key and secret
- one object-storage bucket name
- one object-storage region
- one object-storage endpoint only if you use a non-AWS S3-compatible service
- whether that object-storage provider requires path-style access

Recommended defaults:

- for AWS S3:
  - leave `objectStorage.endpoint` empty
  - use `forcePathStyle: false`
- for most S3-compatible providers:
  - set the real `objectStorage.endpoint`
  - set `forcePathStyle` to whatever that provider expects
- for managed Postgres:
  - prefer a full connection-string secret over separate host/user/password fields
  - keep `sslMode: require` unless you know your target requires `verify-full`

### 3. Build the four images the Helm chart needs

Build from the tracked Dockerfiles:

```bash
docker build -f image/api/Dockerfile -t rivet-local/api:dev .
docker build -f image/executor/Dockerfile -t rivet-local/executor:dev .
docker build -f image/web/Dockerfile -t rivet-local/web:dev .
docker build -f image/proxy/Dockerfile -t rivet-local/proxy:dev .
```

Note:

- `image/web` and `image/executor` expect the upstream `rivet/` tree to exist
- if it is missing, run `npm run setup` before building

### 4. Create the Kubernetes namespace and secrets

```bash
kubectl create namespace rivet-local

kubectl -n rivet-local create secret generic rivet-auth \
  --from-literal=RIVET_KEY='local-dev-shared-key'

kubectl -n rivet-local create secret generic rivet-postgres-conn \
  --from-literal=connectionString='postgresql://USER:PASSWORD@YOUR_POSTGRES_HOST:5432/YOUR_DB?sslmode=require'

kubectl -n rivet-local create secret generic rivet-object-storage \
  --from-literal=accessKeyId='YOUR_OBJECT_STORAGE_ACCESS_KEY' \
  --from-literal=secretAccessKey='YOUR_OBJECT_STORAGE_SECRET_KEY'
```

### 5. Create a local Helm values file

Create `local-k8s-values.yaml` in the repo root with this content:

```yaml
images:
  proxy:
    repository: rivet-local/proxy
    tag: dev
    pullPolicy: Never
  web:
    repository: rivet-local/web
    tag: dev
    pullPolicy: Never
  api:
    repository: rivet-local/api
    tag: dev
    pullPolicy: Never
  executor:
    repository: rivet-local/executor
    tag: dev
    pullPolicy: Never

clusterDomain: cluster.local

replicaCount:
  proxy: 2
  web: 1
  backend: 1
  execution: 2

autoscaling:
  proxy:
    enabled: false
  web:
    enabled: false
  backend:
    enabled: false
  execution:
    enabled: false

vault:
  enabled: false

auth:
  keySecretName: rivet-auth

workflowStorage:
  backend: managed

runtimeLibraries:
  backend: managed

postgres:
  mode: managed
  connectionStringSecretName: rivet-postgres-conn
  connectionStringSecretKey: connectionString
  sslMode: require

objectStorage:
  endpoint: ""
  bucket: YOUR_OBJECT_STORAGE_BUCKET
  region: YOUR_OBJECT_STORAGE_REGION
  prefix: workflows/
  accessKeySecretName: rivet-object-storage
  secretKeySecretName: rivet-object-storage
  forcePathStyle: false

env:
  RIVET_PUBLISHED_WORKFLOWS_BASE_PATH: /workflows
  RIVET_LATEST_WORKFLOWS_BASE_PATH: /workflows-latest
  RIVET_PROXY_RESOLVER: kube-dns.kube-system.svc.cluster.local
  RIVET_ENABLE_LATEST_REMOTE_DEBUGGER: "true"
  RIVET_REQUIRE_WORKFLOW_KEY: "false"
  RIVET_REQUIRE_UI_GATE_KEY: "false"
```

Why these settings:

- `backend=1` matches the supported contract
- `execution=2` proves the real scale target
- `proxy=2` keeps the ingress tier redundant while endpoint traffic is under load
- `web=1` matches the current low-UI-traffic assumption
- `RIVET_KEY` is still required even with the optional checks disabled, because proxy-to-api trust and `/ws/latest-debugger` still depend on it
- `clusterDomain` should stay `cluster.local` unless your Kubernetes cluster uses a different DNS suffix
- `postgres.connectionStringSecretName` keeps the managed-Postgres contract close to production
- leaving `objectStorage.endpoint` empty is the correct default for AWS S3

Provider-specific adjustments:

- for AWS S3:
  - keep `endpoint: ""`
  - keep `forcePathStyle: false`
- for non-AWS S3-compatible storage:
  - set `endpoint` to the provider URL
  - set `forcePathStyle` to the provider-appropriate value
- if your managed Postgres requires stronger TLS validation than `require`, change `sslMode` accordingly and make sure pod trust configuration matches it

### 6. Lint and install the chart

```bash
helm lint ./charts -f ./local-k8s-values.yaml
helm upgrade --install rivet-local ./charts -n rivet-local -f ./local-k8s-values.yaml --wait
```

### 7. Verify the deployed shape

```bash
kubectl -n rivet-local get pods -o wide
kubectl -n rivet-local get deploy
kubectl -n rivet-local get statefulset
kubectl -n rivet-local get svc
```

Expected shape:

- one backend pod from the StatefulSet
- two execution pods
- two proxy pods
- one web pod

If anything is stuck, inspect logs:

```bash
kubectl -n rivet-local logs -l app.kubernetes.io/component=backend -c api --prefix --tail=200
kubectl -n rivet-local logs -l app.kubernetes.io/component=execution -c api --prefix --tail=200
kubectl -n rivet-local logs -l app.kubernetes.io/component=proxy -c proxy --prefix --tail=200
```

### 8. Expose the app locally

Use the proxy service, not direct API port-forwards:

```bash
kubectl -n rivet-local port-forward service/rivet-local-rivet-proxy 8080:80
```

Then in another terminal:

```bash
curl http://127.0.0.1:8080/api/config
```

Expected:

- `publishedWorkflowsBasePath` is `/workflows`
- `latestWorkflowsBasePath` is `/workflows-latest`
- `remoteDebuggerDefaultWs` is non-empty and points to `/ws/latest-debugger`

### 9. Create or use one trivial published workflow

Use any simple workflow you already have. If you do not already have one:

1. open `http://127.0.0.1:8080`
2. create a trivial workflow
3. publish it to endpoint `hello-world`

You only need one published workflow to prove both paths:

- published: `/workflows/hello-world`
- latest: `/workflows-latest/hello-world`

### 10. Prove the published path is the scaled plane

Run the published endpoint several times:

```bash
npm --prefix wrapper/api run workflow-execution:measure -- --base-url http://127.0.0.1:8080 --endpoint hello-world --kind published --runs 20 --warmups 1
```

That proves the published route is functioning through the Kubernetes proxy plus execution service.

For a stronger routing proof, temporarily remove the execution plane and verify that only published breaks:

```bash
kubectl -n rivet-local scale deployment rivet-local-rivet-execution --replicas=0
kubectl -n rivet-local rollout status deployment/rivet-local-rivet-execution
```

Then check:

- `POST /workflows/hello-world` should fail
- `POST /workflows-latest/hello-world` should still work
- `/api/config` should still work
- the hosted UI should still load

Then restore the execution plane:

```bash
kubectl -n rivet-local scale deployment rivet-local-rivet-execution --replicas=2
kubectl -n rivet-local rollout status deployment/rivet-local-rivet-execution
```

This is the cleanest local proof that published execution is the thing that scales.

### 11. Prove the latest debugger path works in the supported topology

Open the app in the browser through the proxy:

- `http://127.0.0.1:8080`

Then use the real browser-debugging path:

1. open the exact UI flow you use for latest remote debugging
2. open browser DevTools
3. go to `Network`
4. filter to `WS`
5. confirm `/ws/latest-debugger` connects successfully

Now, from another terminal, run one latest request:

```bash
npm --prefix wrapper/api run workflow-execution:measure -- --base-url http://127.0.0.1:8080 --endpoint hello-world --kind latest --runs 1 --warmups 0
```

Expected:

- the `/ws/latest-debugger` connection stays open
- websocket frames appear for that latest run
- you should see latest-run debugger traffic, including `start` and `done`-style events

Now run one published request:

```bash
npm --prefix wrapper/api run workflow-execution:measure -- --base-url http://127.0.0.1:8080 --endpoint hello-world --kind published --runs 1 --warmups 0
```

Expected:

- the published request succeeds
- no new debugger frames appear on `/ws/latest-debugger`

That is the exact contract you care about:

- latest endpoint runs remain debuggable
- published endpoint runs remain non-debuggable
- execution replicas can scale independently

## Test cases and scenarios

Run these as the local acceptance checklist:

1. `docker desktop kubernetes status` shows Kubernetes enabled and `kubectl` uses `docker-desktop`
2. the Helm release comes up with:
   - `backend=1`
   - `execution=2`
   - `proxy=2`
   - `web=1`
3. `GET /api/config` returns a non-empty `remoteDebuggerDefaultWs`
4. `POST /workflows/hello-world` succeeds with `execution=2`
5. `POST /workflows-latest/hello-world` succeeds with `backend=1`
6. browser websocket `/ws/latest-debugger` connects successfully through the proxy
7. latest endpoint execution produces websocket frames on `/ws/latest-debugger`
8. published endpoint execution does not produce websocket frames
9. scaling `execution` to `0` breaks published execution but does not break latest execution or `/ws/latest-debugger`
10. scaling `execution` back to `2` restores published execution

## Failure modes to watch for

- If the chart pods cannot reach Postgres or S3, verify real network reachability from Docker Desktop Kubernetes to those external endpoints.
- If external Postgres uses IP allowlists, make sure your host or Docker Desktop egress path is allowed.
- If S3-compatible storage fails while AWS S3 should work, re-check `objectStorage.endpoint` and `forcePathStyle`.
- If managed Postgres TLS fails, re-check the connection string and `postgres.sslMode`.
- If `/api/config` works but `remoteDebuggerDefaultWs` is empty, `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER` is not actually on in the installed values.
- If `/ws/latest-debugger` fails to connect, verify the request is going through the proxy service, not directly to the API pod.
- If you accidentally stay on the wrong `kubectl` context, the rehearsal is invalid for this machine.

## Cleanup

When done:

```bash
helm uninstall rivet-local -n rivet-local
kubectl delete namespace rivet-local
```

If you used the optional local Docker dependency fallback, tear it down separately:

```bash
docker compose -p rivet-k8s-deps -f ops/docker-compose.managed-services.yml --profile workflow-managed down -v
```

## Explicit assumptions and defaults

- Use Docker Desktop Kubernetes.
- Keep `backend=1`; do not try to scale it.
- Scale every legitimately scalable app deployment to `2` locally:
  - `proxy`
  - `execution`
- Prefer the real external managed Postgres and real external S3 or S3-compatible object storage.
- Treat the local Docker Postgres/MinIO stack as an optional fallback, not the primary path.
- Use port-forwarding to the proxy service instead of adding local ingress, because it preserves the in-cluster proxy routing while keeping setup friction low.
- Disable the optional public/UI auth gates for local convenience, but still provide `RIVET_KEY`.
- Use one trivial published workflow such as `hello-world` to prove both published and latest execution paths.
