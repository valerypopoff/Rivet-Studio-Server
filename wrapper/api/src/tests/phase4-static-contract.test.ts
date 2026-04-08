import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(new URL(`../../../../${relativePath}`, import.meta.url), 'utf8');
}

function renderLocalKubernetesChart(): string {
  return execFileSync(
    'helm',
    ['template', 'rivet', 'charts', '-f', 'charts/overlays/local-kubernetes.yaml'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
}

test('proxy template keeps published traffic on execution upstream, latest debugger traffic on the control-plane API, and hides internal published routes from nginx', () => {
  const proxyTemplate = readRepoFile('image/proxy/default.conf.template');
  const proxyBootstrap = readRepoFile('ops/normalize-workflow-paths.sh');

  assert.match(proxyTemplate, /location = \/__rivet_auth \{[\s\S]*proxy_pass \$api_ui_auth_upstream;/);
  assert.match(proxyTemplate, /location \/api\/ \{[\s\S]*proxy_pass \$api_upstream;/);
  assert.match(proxyTemplate, /location \$\{RIVET_PUBLISHED_WORKFLOWS_BASE_PATH\}\/ \{[\s\S]*proxy_pass \$execution_upstream;/);
  assert.match(proxyTemplate, /location \$\{RIVET_LATEST_WORKFLOWS_BASE_PATH\}\/ \{[\s\S]*proxy_pass \$api_upstream;/);
  assert.match(proxyTemplate, /set \$api_latest_debugger_upstream http:\/\/\$\{RIVET_API_UPSTREAM_HOST\}:\$\{RIVET_API_UPSTREAM_PORT\}\/ws\/latest-debugger;/);
  assert.match(proxyTemplate, /location \/ws\/latest-debugger \{[\s\S]*proxy_pass \$api_latest_debugger_upstream;/);
  assert.match(proxyTemplate, /location \/ws\/latest-debugger \{[\s\S]*proxy_set_header X-Rivet-Proxy-Auth \$\{RIVET_PROXY_AUTH_TOKEN\};/);
  assert.match(proxyTemplate, /location \/ws\/latest-debugger \{[\s\S]*proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(proxyTemplate, /location \/ws\/latest-debugger \{[\s\S]*proxy_set_header Connection \$connection_upgrade;/);
  assert.match(proxyBootstrap, /resolve_proxy_resolver\(\)/);
  assert.match(proxyBootstrap, /export RIVET_PROXY_RESOLVER="\$\(resolve_proxy_resolver "\$\{RIVET_PROXY_RESOLVER:-\}"\)"/);
  assert.ok(!proxyTemplate.includes('location /internal/workflows'));
});

test('chart templates keep control-plane and execution-plane API env contracts distinct', () => {
  const backendStatefulSet = readRepoFile('charts/templates/backend-statefulset.yaml');
  const executionDeployment = readRepoFile('charts/templates/execution-deployment.yaml');
  const proxyDeployment = readRepoFile('charts/templates/proxy-deployment.yaml');
  const helpers = readRepoFile('charts/templates/_helpers.tpl');
  const envPartials = readRepoFile('charts/templates/_env.tpl');

  assert.match(backendStatefulSet, /include "rivet\.env\.apiWorkload".*"profile" "control".*"replicaTier" "none".*"jobWorkerEnabled" "true"/);
  assert.match(executionDeployment, /include "rivet\.env\.apiWorkload".*"profile" "execution".*"replicaTier" "endpoint".*"jobWorkerEnabled" "false"/);
  assert.match(envPartials, /define "rivet\.env\.apiWorkload"/);
  assert.match(envPartials, /name: RIVET_API_PROFILE/);
  assert.match(envPartials, /name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER/);
  assert.match(envPartials, /name: RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED/);
  assert.match(helpers, /define "rivet\.serviceFqdn"/);
  assert.match(proxyDeployment, /name: RIVET_WEB_UPSTREAM_HOST[\s\S]*include "rivet\.serviceFqdn"/);
  assert.match(proxyDeployment, /name: RIVET_API_UPSTREAM_HOST[\s\S]*include "rivet\.serviceFqdn"/);
  assert.match(proxyDeployment, /name: RIVET_EXECUTION_UPSTREAM_HOST[\s\S]*include "rivet\.serviceFqdn"/);
  assert.match(proxyDeployment, /name: RIVET_EXECUTOR_UPSTREAM_HOST[\s\S]*include "rivet\.serviceFqdn"/);
});

test('helm env and pod helpers keep env entries split cleanly and preserve the executor app-data path note', () => {
  let renderedChart: string | null = null;
  try {
    renderedChart = renderLocalKubernetesChart();
  } catch (error) {
    if (!(typeof error === 'object' && error != null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT')) {
      throw error;
    }
  }

  const envPartials = readRepoFile('charts/templates/_env.tpl');
  const podPartials = readRepoFile('charts/templates/_pod.tpl');

  if (renderedChart) {
    assert.match(
      renderedChart,
      /name: RIVET_API_PROFILE\s*\n\s*value: "control"\s*\n\s*- name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER/,
    );
    assert.match(
      renderedChart,
      /name: RIVET_API_PROFILE\s*\n\s*value: "execution"\s*\n\s*- name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER/,
    );
  } else {
    assert.match(
      envPartials,
      /- name: RIVET_API_PROFILE\s*\n\s*value: \{\{ \.profile \| quote \}\}\s*\n- name: RIVET_STORAGE_MODE/,
    );
    assert.match(
      envPartials,
      /\{\{ include "rivet\.env\.objectStorage" \(dict "root" \$root "includePrefix" true\) \}\}\s*\n\{\{ include "rivet\.env\.postgres" \$root \}\}/,
    );
    assert.match(
      envPartials,
      /\{\{ include "rivet\.env\.objectStorage" \(dict "root" \$root "includePrefix" false\) \}\}\s*\n\{\{ include "rivet\.env\.postgres" \$root \}\}/,
    );
  }

  assert.match(
    podPartials,
    /The executor keeps the Rivet desktop-app storage layout on purpose\.\s*\n# Do not unify this mount path with the API app-data mount\./,
  );
  assert.match(podPartials, /mountPath: \/home\/rivet\/\.local\/share\/com\.ironcladapp\.rivet/);
});

test('chart validation keeps the first Phase 4 split managed-only', () => {
  const validateValuesTemplate = readRepoFile('charts/templates/validate-values.yaml');

  assert.match(
    validateValuesTemplate,
    /The phase 4 chart shape requires workflowStorage\.backend=managed and runtimeLibraries\.backend=managed/,
  );
  assert.match(
    validateValuesTemplate,
    /replicaCount\.backend=1 because latest-workflow execution and \/ws\/latest-debugger are still process-local control-plane features/,
  );
  assert.match(
    validateValuesTemplate,
    /autoscaling\.backend\.enabled=false because latest-workflow execution and \/ws\/latest-debugger are still process-local control-plane features/,
  );
});

test('production overlay keeps the supported ingress, Vault, and scale boundaries for the real cluster topology', () => {
  const prodOverlay = readRepoFile('charts/overlays/prod.yaml');

  assert.match(prodOverlay, /ingress:\s*\n\s*enabled:\s*true/);
  assert.match(prodOverlay, /vault:\s*\n\s*enabled:\s*true/);
  assert.match(prodOverlay, /backend:\s*1/);
  assert.match(prodOverlay, /web:\s*1/);
  assert.match(prodOverlay, /execution:\s*[2-9]\d*/);
  assert.match(prodOverlay, /proxy:\s*\n\s*enabled:\s*true/);
  assert.match(prodOverlay, /web:\s*\n\s*enabled:\s*false/);
  assert.match(prodOverlay, /backend:\s*\n\s*enabled:\s*false/);
  assert.match(prodOverlay, /execution:\s*\n\s*enabled:\s*true/);
});

test('local Kubernetes overlay keeps the backend singleton while scaling endpoint-serving tiers and enabling latest debugger support', () => {
  const localOverlay = readRepoFile('charts/overlays/local-kubernetes.yaml');

  assert.match(localOverlay, /repository:\s*rivet-local\/proxy/);
  assert.match(localOverlay, /repository:\s*rivet-local\/web/);
  assert.match(localOverlay, /repository:\s*rivet-local\/api/);
  assert.match(localOverlay, /repository:\s*rivet-local\/executor/);
  assert.match(localOverlay, /backend:\s*1/);
  assert.match(localOverlay, /web:\s*1/);
  assert.match(localOverlay, /execution:\s*2/);
  assert.match(localOverlay, /RIVET_ENABLE_LATEST_REMOTE_DEBUGGER:\s*"true"/);
  assert.match(localOverlay, /RIVET_REQUIRE_WORKFLOW_KEY:\s*"false"/);
  assert.match(localOverlay, /RIVET_REQUIRE_UI_GATE_KEY:\s*"false"/);
});
