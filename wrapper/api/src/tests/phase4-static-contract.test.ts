import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(new URL(`../../../../${relativePath}`, import.meta.url), 'utf8');
}

test('proxy template keeps published traffic on execution upstream and hides internal published route from nginx', () => {
  const proxyTemplate = readRepoFile('image/proxy/default.conf.template');

  assert.match(proxyTemplate, /location = \/__rivet_auth \{[\s\S]*proxy_pass \$api_ui_auth_upstream;/);
  assert.match(proxyTemplate, /location \/api\/ \{[\s\S]*proxy_pass \$api_upstream;/);
  assert.match(proxyTemplate, /location \$\{RIVET_PUBLISHED_WORKFLOWS_BASE_PATH\}\/ \{[\s\S]*proxy_pass \$execution_upstream;/);
  assert.match(proxyTemplate, /location \$\{RIVET_LATEST_WORKFLOWS_BASE_PATH\}\/ \{[\s\S]*proxy_pass \$api_upstream;/);
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
});
