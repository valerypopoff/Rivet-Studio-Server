import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(new URL(`../../../../${relativePath}`, import.meta.url), 'utf8');
}

test('proxy template keeps published traffic on execution upstream, latest debugger traffic on the control-plane API, and hides internal published routes from nginx', () => {
  const proxyTemplate = readRepoFile('image/proxy/default.conf.template');

  assert.match(proxyTemplate, /location = \/__rivet_auth \{[\s\S]*proxy_pass \$api_ui_auth_upstream;/);
  assert.match(proxyTemplate, /location \/api\/ \{[\s\S]*proxy_pass \$api_upstream;/);
  assert.match(proxyTemplate, /location \$\{RIVET_PUBLISHED_WORKFLOWS_BASE_PATH\}\/ \{[\s\S]*proxy_pass \$execution_upstream;/);
  assert.match(proxyTemplate, /location \$\{RIVET_LATEST_WORKFLOWS_BASE_PATH\}\/ \{[\s\S]*proxy_pass \$api_upstream;/);
  assert.match(proxyTemplate, /set \$api_latest_debugger_upstream http:\/\/\$\{RIVET_API_UPSTREAM_HOST\}:\$\{RIVET_API_UPSTREAM_PORT\}\/ws\/latest-debugger;/);
  assert.match(proxyTemplate, /location \/ws\/latest-debugger \{[\s\S]*proxy_pass \$api_latest_debugger_upstream;/);
  assert.match(proxyTemplate, /location \/ws\/latest-debugger \{[\s\S]*proxy_set_header X-Rivet-Proxy-Auth \$\{RIVET_PROXY_AUTH_TOKEN\};/);
  assert.match(proxyTemplate, /location \/ws\/latest-debugger \{[\s\S]*proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(proxyTemplate, /location \/ws\/latest-debugger \{[\s\S]*proxy_set_header Connection \$connection_upgrade;/);
  assert.ok(!proxyTemplate.includes('location /internal/workflows'));
});

test('chart templates keep control-plane and execution-plane API env contracts distinct', () => {
  const backendStatefulSet = readRepoFile('charts/templates/backend-statefulset.yaml');
  const executionDeployment = readRepoFile('charts/templates/execution-deployment.yaml');

  assert.match(backendStatefulSet, /name: RIVET_API_PROFILE\s+value: control/);
  assert.match(backendStatefulSet, /name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER\s+value: none/);
  assert.match(backendStatefulSet, /name: RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED\s+value: "true"/);

  assert.match(executionDeployment, /name: RIVET_API_PROFILE\s+value: execution/);
  assert.match(executionDeployment, /name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER\s+value: endpoint/);
  assert.match(executionDeployment, /name: RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED\s+value: "false"/);
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

test('production overlay keeps the backend singleton while allowing execution scale-out', () => {
  const prodOverlay = readRepoFile('charts/overlays/prod.yaml');

  assert.match(prodOverlay, /backend:\s*1/);
  assert.match(prodOverlay, /execution:\s*[2-9]\d*/);
  assert.match(prodOverlay, /backend:\s*\n\s*enabled:\s*false/);
});
