import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(new URL(`../../../../${relativePath}`, import.meta.url), 'utf8');
}

function readRepoFileBytes(relativePath: string): Buffer {
  return fs.readFileSync(new URL(`../../../../${relativePath}`, import.meta.url));
}

function repoFileExists(relativePath: string): boolean {
  return fs.existsSync(new URL(`../../../../${relativePath}`, import.meta.url));
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
  const proxyBootstrap = readRepoFile('image/proxy/normalize-workflow-paths.sh');

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

test('proxy shell entrypoints stay LF-normalized for Linux containers', () => {
  const gitattributes = readRepoFile('.gitattributes');
  const proxyBootstrapBytes = readRepoFileBytes('image/proxy/normalize-workflow-paths.sh');

  assert.match(gitattributes, /^\*\.sh text eol=lf$/m);
  assert.equal(proxyBootstrapBytes.includes(Buffer.from('\r\n')), false);
  assert.match(proxyBootstrapBytes.toString('utf8'), /^#!\/bin\/sh\n/);
});

test('proxy UI gate prompt is staged into container-local storage before nginx serves it', () => {
  const proxyBootstrap = readRepoFile('image/proxy/normalize-workflow-paths.sh');
  const imageProxyTemplate = readRepoFile('image/proxy/default.conf.template');
  const prodProxyTemplate = readRepoFile('ops/nginx/default.conf.template');
  const devProxyTemplate = readRepoFile('ops/nginx/default.dev.conf.template');
  const prodCompose = readRepoFile('ops/compose/docker-compose.yml');
  const devCompose = readRepoFile('ops/compose/docker-compose.dev.yml');

  for (const template of [imageProxyTemplate, prodProxyTemplate, devProxyTemplate]) {
    assert.match(template, /location @web_with_ui_gate_prompt \{[\s\S]*root \/tmp\/nginx\/html;[\s\S]*try_files \/ui-gate-prompt\.html =500;/);
    assert.doesNotMatch(template, /root \/usr\/share\/nginx\/html;/);
  }

  assert.match(proxyBootstrap, /stage_ui_gate_prompt\(\) \{/);
  assert.match(proxyBootstrap, /destination_dir="\/tmp\/nginx\/html"/);
  assert.match(proxyBootstrap, /for candidate in \/tmp\/ui-gate-prompt\.html \/usr\/share\/nginx\/html\/ui-gate-prompt\.html; do/);
  assert.match(proxyBootstrap, /cp "\$source" "\$destination"/);

  for (const composeFile of [prodCompose, devCompose]) {
    assert.match(composeFile, /image\/proxy\/ui-gate-prompt\.html:\/tmp\/ui-gate-prompt\.html:ro/);
    assert.doesNotMatch(composeFile, /ui-gate-prompt\.html:\/usr\/share\/nginx\/html\/ui-gate-prompt\.html:ro/);
  }
});

test('proxy templates pin standard HTTP upstream routes to the configurable 3 minute timeout while keeping websocket routes long-lived', () => {
  const imageProxyTemplate = readRepoFile('image/proxy/default.conf.template');
  const prodProxyTemplate = readRepoFile('ops/nginx/default.conf.template');
  const devProxyTemplate = readRepoFile('ops/nginx/default.dev.conf.template');
  const proxyDockerfile = readRepoFile('image/proxy/Dockerfile');

  for (const template of [imageProxyTemplate, prodProxyTemplate, devProxyTemplate]) {
    assert.match(template, /location \/api\/ \{[\s\S]*proxy_read_timeout \$\{RIVET_PROXY_READ_TIMEOUT\};[\s\S]*proxy_send_timeout \$\{RIVET_PROXY_READ_TIMEOUT\};/);
    assert.match(template, /location \$\{RIVET_PUBLISHED_WORKFLOWS_BASE_PATH\}\/ \{[\s\S]*proxy_read_timeout \$\{RIVET_PROXY_READ_TIMEOUT\};[\s\S]*proxy_send_timeout \$\{RIVET_PROXY_READ_TIMEOUT\};/);
    assert.match(template, /location \$\{RIVET_LATEST_WORKFLOWS_BASE_PATH\}\/ \{[\s\S]*proxy_read_timeout \$\{RIVET_PROXY_READ_TIMEOUT\};[\s\S]*proxy_send_timeout \$\{RIVET_PROXY_READ_TIMEOUT\};/);
    assert.match(template, /location \/ws\/latest-debugger \{[\s\S]*proxy_read_timeout 86400s;/);
    assert.match(template, /location \/ws\/executor\/internal \{[\s\S]*proxy_read_timeout 86400s;/);
  }

  assert.match(proxyDockerfile, /ENV RIVET_PROXY_READ_TIMEOUT=180s/);
});

test('executor production image and compose contracts pin the websocket service to 21889 independently of the API PORT env', () => {
  const executorEntrypoint = readRepoFile('image/executor/entrypoint.sh');
  const executorDockerfile = readRepoFile('image/executor/Dockerfile');
  const composeExecutorDockerfile = readRepoFile('ops/docker/Dockerfile.executor');
  const prodCompose = readRepoFile('ops/compose/docker-compose.yml');
  const devCompose = readRepoFile('ops/compose/docker-compose.dev.yml');

  assert.match(executorEntrypoint, /export RIVET_EXECUTOR_PORT="\$\{RIVET_EXECUTOR_PORT:-21889\}"/);
  assert.match(executorEntrypoint, /export RIVET_EXECUTOR_HOST="\$\{RIVET_EXECUTOR_HOST:-0\.0\.0\.0\}"/);
  assert.match(executorEntrypoint, /exec node \/app\/executor-bundle\.cjs --host "\$\{RIVET_EXECUTOR_HOST\}" --port "\$\{RIVET_EXECUTOR_PORT\}"/);
  assert.doesNotMatch(executorEntrypoint, /exec node \/app\/executor-bundle\.cjs --port "\$\{PORT\}"/);
  assert.match(executorDockerfile, /ENV RIVET_EXECUTOR_PORT=21889/);
  assert.match(executorDockerfile, /ENV RIVET_EXECUTOR_HOST=0\.0\.0\.0/);
  assert.match(executorDockerfile, /ENV RIVET_CODE_RUNNER_REQUIRE_ROOT=\/data\/runtime-libraries\/current\/node_modules/);
  assert.doesNotMatch(executorDockerfile, /ENV PORT=21889/);
  assert.match(composeExecutorDockerfile, /ENV RIVET_EXECUTOR_HOST=0\.0\.0\.0/);
  assert.ok(composeExecutorDockerfile.includes('node executor-bundle.cjs --host \\"${RIVET_EXECUTOR_HOST}\\" --port 21889'));
  assert.match(prodCompose, /executor:[\s\S]*- PORT=21889[\s\S]*- RIVET_EXECUTOR_PORT=21889[\s\S]*- RIVET_EXECUTOR_HOST=0\.0\.0\.0/);
  assert.match(devCompose, /executor:[\s\S]*- PORT=21889[\s\S]*- RIVET_EXECUTOR_PORT=21889[\s\S]*- RIVET_EXECUTOR_HOST=0\.0\.0\.0/);
});

test('API images link workflow execution to the embedded Rivet source tree', () => {
  const apiDockerfile = readRepoFile('image/api/Dockerfile');
  const apiEntrypoint = readRepoFile('image/api/entrypoint.sh');
  const composeApiDockerfile = readRepoFile('ops/docker/Dockerfile.api');
  const prodCompose = readRepoFile('ops/compose/docker-compose.yml');
  const devCompose = readRepoFile('ops/compose/docker-compose.dev.yml');
  const kubernetesLauncher = readRepoFile('scripts/dev-kubernetes.mjs');
  const devDockerLauncher = readRepoFile('scripts/dev-docker.mjs');
  const prodDockerLauncher = readRepoFile('scripts/prod-docker.mjs');
  const rivetContextHelper = readRepoFile('scripts/lib/rivet-source-context.mjs');
  const imageBuildWorkflow = readRepoFile('.github/workflows/build-images.yml');
  const linkScript = readRepoFile('scripts/link-rivet-node-package.mjs');
  const apiPackageJson = readRepoFile('wrapper/api/package.json');
  const apiTsconfig = readRepoFile('wrapper/api/tsconfig.json');
  const preserveSymlinksRunner = readRepoFile('scripts/run-preserve-symlinks.mjs');
  const ensureDevDeps = readRepoFile('scripts/ensure-dev-deps.mjs');

  for (const dockerfile of [apiDockerfile, composeApiDockerfile]) {
    assert.match(dockerfile, /COPY --from=rivet_source \. rivet\//);
    assert.match(dockerfile, /yarn workspace @ironclad\/rivet-core run build/);
    assert.match(dockerfile, /yarn workspace @ironclad\/rivet-node run build/);
    assert.match(dockerfile, /COPY scripts\/link-rivet-node-package\.mjs scripts\/link-rivet-node-package\.mjs/);
    assert.match(dockerfile, /RUN node \/app\/scripts\/link-rivet-node-package\.mjs/);
  }

  assert.match(apiDockerfile, /COPY --from=builder --chown=10001:10001 \/app\/rivet\/node_modules \/app\/rivet\/node_modules/);
  assert.match(apiDockerfile, /COPY --from=builder --chown=10001:10001 \/app\/rivet\/packages\/core \/app\/rivet\/packages\/core/);
  assert.match(apiDockerfile, /COPY --from=builder --chown=10001:10001 \/app\/rivet\/packages\/node \/app\/rivet\/packages\/node/);
  assert.match(linkScript, /@ironclad\/\$\{pkg\.name\}/);
  assert.match(linkScript, /source: path\.join\(rivetRootDir, 'packages', 'node'\)/);
  assert.match(linkScript, /\.rivet-package-links/);
  assert.match(linkScript, /const rivetNodeModulesDir = path\.join\(rivetRootDir, 'node_modules'\)/);
  assert.match(linkScript, /fs\.copyFileSync\(packageJsonPath, path\.join\(packageLinkDir, 'package\.json'\)\)/);
  assert.match(linkScript, /linkDirectory\(rivetNodeModulesDir, path\.join\(packageLinkDir, 'node_modules'\)\)/);
  assert.doesNotMatch(linkScript, /packages\[1\]\.source, 'node_modules'/);
  assert.doesNotMatch(linkScript, /nodePackageCoreDependency/);
  assert.match(ensureDevDeps, /hasExpectedApiRivetLink\('rivet-core', 'rivet\/packages\/core'\)/);
  assert.match(ensureDevDeps, /hasExpectedApiRivetLink\('rivet-node', 'rivet\/packages\/node'\)/);
  assert.match(ensureDevDeps, /\.rivet-package-links\/\$\{packageName\}/);
  assert.match(ensureDevDeps, /isLinkedTo\(path\.join\(overlayRelPath, 'node_modules'\), 'rivet\/node_modules'\)/);
  assert.match(apiTsconfig, /"preserveSymlinks": true/);
  assert.match(apiPackageJson, /run-preserve-symlinks\.mjs tsx/);
  assert.match(apiPackageJson, /node --preserve-symlinks dist\/api\/src\/server\.js/);
  assert.match(preserveSymlinksRunner, /--preserve-symlinks/);
  assert.match(apiEntrypoint, /exec node --preserve-symlinks \/app\/wrapper\/api\/dist\/api\/src\/server\.js/);
  assert.match(composeApiDockerfile, /node --preserve-symlinks dist\/api\/src\/server\.js/);
  for (const compose of [prodCompose, devCompose]) {
    assert.match(compose, /additional_contexts:\s*\n\s*rivet_source: \$\{RIVET_SOURCE_BUILD_CONTEXT_PATH:-\.\.\/\.\.\/rivet\}/);
  }
  assert.match(devCompose, /api:[\s\S]*depends_on:\s*\n\s*web:\s*\n\s*condition: service_healthy/);
  assert.match(devCompose, /api:[\s\S]*- rivet_node_modules:\/workspace\/rivet\/node_modules/);
  assert.match(devCompose, /cp -a \/workspace\/rivet\/packages\/core \/app\/\.rivet-source\/packages\/core/);
  assert.match(devCompose, /ln -s \/workspace\/rivet\/node_modules \/app\/\.rivet-source\/node_modules/);
  assert.match(devCompose, /\.\.\/\.\.\/scripts:\/scripts:ro/);
  assert.match(devCompose, /RIVET_SOURCE_ROOT=\/app\/\.rivet-source RIVET_API_PACKAGE_ROOT=\/app node \/workspace\/scripts\/link-rivet-node-package\.mjs/);
  assert.match(devCompose, /NODE_OPTIONS='\$\{NODE_OPTIONS:-\} --import=\/opt\/proxy-bootstrap\/bootstrap\.mjs'/);
  assert.match(devDockerLauncher, /prepareRivetDockerContext\(rootDir, mergedEnv\)/);
  assert.match(prodDockerLauncher, /prepareRivetDockerContext\(rootDir, mergedEnv\)/);
  assert.ok(rivetContextHelper.includes("const contextRootRelPath = path.join('.data', 'docker-contexts');"));
  assert.ok(rivetContextHelper.includes("const defaultContextRelPath = path.join(contextRootRelPath, 'rivet-source');"));
  assert.match(rivetContextHelper, /Excluded dependency folders, build output, VCS data, and Yarn cache artifacts/);
  assert.match(kubernetesLauncher, /--build-context/);
  assert.match(kubernetesLauncher, /rivet_source=\$\{rivetSourceBuildContextPath\}/);
  assert.match(imageBuildWorkflow, /build-contexts:\s*\|\s*\n\s*rivet_source=\.\/rivet/);
});

test('hosted editor opened-project overrides follow Rivet 2 project metadata and snapshot state', () => {
  const openWorkflowProject = readRepoFile('wrapper/web/dashboard/useOpenWorkflowProject.ts');
  const loadProjectOverride = readRepoFile('wrapper/web/overrides/hooks/useLoadProject.ts');
  const syncOpenedProjectsOverride = readRepoFile('wrapper/web/overrides/hooks/useSyncCurrentStateIntoOpenedProjects.ts');

  assert.match(openWorkflowProject, /openedProjectSnapshotsState/);
  assert.match(openWorkflowProject, /useStore/);
  assert.match(openWorkflowProject, /activeOpenedProjectIds/);
  assert.match(openWorkflowProject, /resetOpenProjectState/);
  assert.match(openWorkflowProject, /function removeOpenedProject/);
  assert.match(openWorkflowProject, /withHostedProjectTitle/);
  assert.match(openWorkflowProject, /title: resolveHostedProjectTitle\(project, filePath\)/);
  assert.match(openWorkflowProject, /projectId: project\.metadata\.id/);
  assert.match(openWorkflowProject, /const projectSnapshot = \{/);
  assert.match(openWorkflowProject, /data: project\.data/);
  assert.match(openWorkflowProject, /await loadProject\(projectInfo, projectSnapshot\)/);
  assert.match(openWorkflowProject, /removeOpenedProject\(prev, project\.metadata\.id\)/);
  assert.doesNotMatch(openWorkflowProject, /projectInfo\.project\./);

  assert.match(loadProjectOverride, /openedProjectSnapshotsState/);
  assert.match(loadProjectOverride, /useWorkspaceTransitions/);
  assert.match(loadProjectOverride, /useStore/);
  assert.match(loadProjectOverride, /providedSnapshot/);
  assert.match(loadProjectOverride, /Promise<boolean>/);
  assert.match(loadProjectOverride, /store\.get\(openedProjectSnapshotsState\)/);
  assert.match(loadProjectOverride, /loadedProject\.loaded/);
  assert.match(loadProjectOverride, /projectInfo\.projectId/);
  assert.doesNotMatch(loadProjectOverride, /setProject\(projectInfo\.project\)/);

  assert.match(syncOpenedProjectsOverride, /addOpenedProject/);
  assert.match(syncOpenedProjectsOverride, /resolveHostedProjectTitle/);
  assert.match(syncOpenedProjectsOverride, /withHostedProjectTitle/);
  assert.match(syncOpenedProjectsOverride, /suppressedClosedProjectIdsRef/);
  assert.match(syncOpenedProjectsOverride, /openedProjectIds\.length > 0 && !openedProjectIds\.includes\(currentProjectId\)/);
  assert.match(syncOpenedProjectsOverride, /Object\.keys\(previousProjects\.openedProjects\)\.length !== nextOpenedProjectIds\.length/);
  assert.match(syncOpenedProjectsOverride, /openProjectIdSet/);
  assert.match(syncOpenedProjectsOverride, /openedProjectSnapshotsState/);
  assert.doesNotMatch(syncOpenedProjectsOverride, /project: currentProject/);
});

test('hosted executor integration keeps Rivet 2 transport ownership and removes stale wrapper transport overrides', () => {
  const viteAliases = readRepoFile('wrapper/web/vite-aliases.ts');
  const hostedEditorApp = readRepoFile('wrapper/web/dashboard/HostedEditorApp.tsx');
  const upstreamExecutorSession = readRepoFile('rivet/packages/app/src/hooks/useExecutorSession.ts');
  const upstreamRemoteDebugger = readRepoFile('rivet/packages/app/src/hooks/useRemoteDebugger.ts');
  const packageJson = readRepoFile('package.json');

  assert.match(hostedEditorApp, /executor=\{\{ internalExecutorUrl: RIVET_EXECUTOR_WS_URL \}\}/);
  assert.match(upstreamExecutorSession, /runtime\.connectInternal\(hostConfig\.internalExecutorUrl\)/);
  assert.match(upstreamRemoteDebugger, /shouldRestoreInternalNodeExecutorAfterDebuggerDisconnect/);
  assert.match(upstreamRemoteDebugger, /runtime\.connectInternal\(hostConfig\?\.internalExecutorUrl\)/);
  assert.doesNotMatch(viteAliases, /useExecutorSession/);
  assert.doesNotMatch(viteAliases, /useRemoteDebugger/);
  assert.doesNotMatch(viteAliases, /useGraphExecutor/);
  assert.doesNotMatch(viteAliases, /useRemoteExecutor/);

  for (const stalePath of [
    'wrapper/web/overrides/hooks/hostedInternalExecutorSession.ts',
    'wrapper/web/overrides/hooks/useHostedExecutorSession.ts',
    'wrapper/web/overrides/hooks/useHostedRemoteDebugger.ts',
    'wrapper/web/tests/hosted-executor-session.test.ts',
    'wrapper/web/overrides/hooks/useGraphExecutor.ts',
    'wrapper/web/overrides/hooks/useRemoteExecutor.ts',
    'wrapper/web/overrides/hooks/useRemoteDebugger.ts',
    'wrapper/web/overrides/hooks/remoteDebuggerClient.ts',
    'wrapper/web/overrides/hooks/remoteDebuggerDatasets.ts',
    'wrapper/web/overrides/components/DebuggerConnectPanel.tsx',
  ]) {
    assert.equal(repoFileExists(stalePath), false, `${stalePath} should not be retained after the Rivet 2 seam migration`);
  }

  assert.doesNotMatch(packageJson, /remote-execution-session\.test/);
  assert.doesNotMatch(packageJson, /remote-executor-protocol\.test/);
});

test('hosted save shortcuts use upstream save flow and RivetAppHost callbacks', () => {
  const viteAliases = readRepoFile('wrapper/web/vite-aliases.ts');
  const hostedEditorApp = readRepoFile('wrapper/web/dashboard/HostedEditorApp.tsx');
  const editorMessageBridge = readRepoFile('wrapper/web/dashboard/EditorMessageBridge.tsx');
  const upstreamWorkspaceTransitions = readRepoFile('rivet/packages/app/src/hooks/useWorkspaceTransitions.ts');
  const windowsHotkeysFix = readRepoFile('wrapper/web/overrides/hooks/useWindowsHotkeysFix.tsx');

  assert.match(hostedEditorApp, /onProjectSaved=\{handleProjectSaved\}/);
  assert.match(hostedEditorApp, /onActiveProjectChanged=\{handleActiveProjectChanged\}/);
  assert.match(hostedEditorApp, /onOpenProjectCountChanged=\{handleOpenProjectCountChanged\}/);
  assert.match(editorMessageBridge, /rivet\/packages\/app\/src\/hooks\/useSaveProject/);
  assert.doesNotMatch(editorMessageBridge, /rivet-project-saved/);
  assert.doesNotMatch(viteAliases, /useSaveProject/);
  assert.doesNotMatch(viteAliases, /useMenuCommands/);
  assert.match(upstreamWorkspaceTransitions, /hostCallbacks\.onProjectSaved/);
  assert.match(windowsHotkeysFix, /menuId === 'save_project' && isHostedMode\(\)/);

  for (const stalePath of [
    'wrapper/web/overrides/hooks/useSaveProject.ts',
    'wrapper/web/overrides/hooks/useMenuCommands.ts',
  ]) {
    assert.equal(repoFileExists(stalePath), false, `${stalePath} should stay removed in favor of upstream save/menu seams`);
  }
});

test('hosted web module overrides are scoped to upstream Rivet app importers', () => {
  const viteConfig = readRepoFile('wrapper/web/vite.config.ts');
  const viteAliases = readRepoFile('wrapper/web/vite-aliases.ts');
  const updateCheck = readRepoFile('scripts/update-check.sh');
  const updateCheckAliasedFiles = updateCheck.match(/ALIASED_FILES=\([\s\S]*?\n\)/)?.[0] ?? '';

  assert.match(viteConfig, /const normalizedUpstreamAppSrc = normalizePath\(resolve\(upstreamApp, 'src'\)\)/);
  assert.match(viteConfig, /name: 'resolve-rivet-module-override'/);
  assert.match(viteConfig, /isUpstreamAppSourceImporter\(importer\)/);
  assert.match(viteConfig, /createModuleOverrideAliases\(overrideDir\)/);
  assert.doesNotMatch(viteConfig, /\.\.\.createModuleOverrideAliases\(overrideDir\)/);
  assert.match(viteAliases, /useLoadProject/);
  assert.match(viteAliases, /useSyncCurrentStateIntoOpenedProjects/);
  assert.doesNotMatch(viteAliases, /TauriProjectReferenceLoader/);
  assert.doesNotMatch(viteAliases, /datasets/);
  assert.doesNotMatch(viteAliases, /useExecutorSession/);
  assert.doesNotMatch(viteAliases, /useRemoteDebugger/);
  assert.doesNotMatch(updateCheckAliasedFiles, /model\/TauriProjectReferenceLoader\.ts/);
  assert.doesNotMatch(updateCheckAliasedFiles, /io\/datasets\.ts/);
  assert.match(updateCheck, /Checking upstream provider seams/);
  assert.match(updateCheck, /readRelativeProjectFile/);
  assert.match(updateCheck, /getDefaultPathPolicyProvider/);

  for (const stalePath of [
    'wrapper/web/overrides/model/TauriProjectReferenceLoader.ts',
    'wrapper/web/overrides/io/datasets.ts',
  ]) {
    assert.equal(repoFileExists(stalePath), false, `${stalePath} should stay removed in favor of upstream provider seams`);
  }
});

test('docker compose files keep runtime caches and executor app-data under /home/rivet to match the non-root image contract', () => {
  const prodCompose = readRepoFile('ops/compose/docker-compose.yml');
  const devCompose = readRepoFile('ops/compose/docker-compose.dev.yml');

  for (const compose of [prodCompose, devCompose]) {
    assert.match(compose, /- HOME=\/home\/rivet/);
    assert.match(compose, /- npm_config_cache=\/home\/rivet\/\.npm/);
    assert.match(compose, /- YARN_CACHE_FOLDER=\/home\/rivet\/\.cache\/yarn/);
    assert.match(compose, /\/home\/rivet\/\.local\/share\/com\.ironcladapp\.rivet/);
    assert.doesNotMatch(compose, /\/root\/\.npm/);
    assert.doesNotMatch(compose, /\/root\/\.cache\/yarn/);
    assert.doesNotMatch(compose, /HOME=\/root/);
    assert.doesNotMatch(compose, /\/root\/\.local\/share\/com\.ironcladapp\.rivet/);
  }
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
