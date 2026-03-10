import { defineConfig, normalizePath, splitVendorChunkPlugin } from 'vite';
import type { PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import svgr from 'vite-plugin-svgr';
import monacoEditorPlugin from 'vite-plugin-monaco-editor';
import topLevelAwait from 'vite-plugin-top-level-await';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const upstreamApp = resolve(__dirname, '../../rivet/packages/app');
const upstreamCore = resolve(__dirname, '../../rivet/packages/core');
const upstreamTrivet = resolve(__dirname, '../../rivet/packages/trivet');
const normalizedVendoredRoots = [upstreamApp, upstreamCore, upstreamTrivet].map((root) => normalizePath(root));
const shimDir = resolve(__dirname, 'shims');
const overrideDir = resolve(__dirname, 'overrides');
const webDistDir = resolve(__dirname, 'dist');

const wrapperRequire = createRequire(resolve(__dirname, 'package.json'));

const isBareImport = (specifier: string) => {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('\0') && !specifier.startsWith('virtual:');
};

const splitImportSuffix = (specifier: string) => {
  const match = /[?#]/.exec(specifier);

  if (!match || match.index === undefined) {
    return { path: specifier, suffix: '' };
  }

  return {
    path: specifier.slice(0, match.index),
    suffix: specifier.slice(match.index),
  };
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const wrapperPackageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};

const wrapperAliasedDependencies = Object.keys(wrapperPackageJson.dependencies ?? {}).filter(
  (dependency) =>
    !dependency.startsWith('@ironclad/') &&
    !dependency.startsWith('@tauri-apps/') &&
    !dependency.startsWith('@types/') &&
    dependency !== 'assemblyai' &&
    dependency !== '@google/genai' &&
    dependency !== 'nanoid' &&
    dependency !== 'vite' &&
    !dependency.startsWith('@vitejs/') &&
    !dependency.startsWith('vite-'),
);

const resolveWrapperImport = (specifier: string) => {
  if (specifier === 'yaml') {
    return resolve(__dirname, 'node_modules/yaml/browser/index.js');
  }

  if (specifier === 'yaml/util') {
    return resolve(__dirname, 'node_modules/yaml/browser/dist/util.js');
  }

  try {
    return wrapperRequire.resolve(specifier);
  } catch {
    const packageJsonPath = wrapperRequire.resolve(`${specifier}/package.json`);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      module?: string;
      main?: string;
    };
    const entry = packageJson.module ?? packageJson.main ?? 'index.js';
    return resolve(packageJsonPath, '..', entry);
  }
};

const wrapperExactDependencyAliases = wrapperAliasedDependencies
  .map((dependency) => ({
    find: new RegExp(`^${escapeRegExp(dependency)}$`),
    replacement: resolveWrapperImport(dependency),
  }));

const browserSafeGoogleModule = resolve(overrideDir, 'core/plugins/google/google.ts');

const resolveBrowserSafeGoogleCoreModule = (): PluginOption => ({
  name: 'resolve-browser-safe-google-core-module',
  async resolveId(source, importer) {
    if (!importer) {
      return null;
    }

    const normalizedImporter = normalizePath(importer);

    if (
      (source === '../google.js' || source === '../google.ts') &&
      normalizedImporter === normalizePath(resolve(upstreamCore, 'src/plugins/google/nodes/ChatGoogleNode.ts'))
    ) {
      return this.resolve(browserSafeGoogleModule, importer, { skipSelf: true });
    }

    return null;
  },
});

// These packages need explicit browser-safe entry points because their default upstream
// resolution paths can pull in Node-oriented modules that break the hosted web bundle.
const wrapperTargetedSubpathAliases = [
  { find: /^assemblyai$/, replacement: resolve(__dirname, 'node_modules/assemblyai/dist/browser.mjs') },
  { find: /^@google\/genai$/, replacement: resolve(__dirname, 'node_modules/@google/genai/dist/web/index.mjs') },
  { find: /^nanoid$/, replacement: resolve(__dirname, 'node_modules/nanoid/index.browser.js') },
  { find: /^nanoid\/non-secure$/, replacement: resolve(__dirname, 'node_modules/nanoid/non-secure/index.js') },
  { find: /^yaml$/, replacement: resolve(__dirname, 'node_modules/yaml/browser/index.js') },
  { find: /^yaml\/util$/, replacement: resolve(__dirname, 'node_modules/yaml/browser/dist/util.js') },
];

const resolveWrapperDependency = (): PluginOption => ({
  name: 'resolve-wrapper-dependency',
  async resolveId(source, importer) {
    if (!importer || !isBareImport(source)) {
      return null;
    }

    const normalizedImporter = normalizePath(importer);

    if (!normalizedVendoredRoots.some((root) => normalizedImporter.startsWith(root))) {
      return null;
    }

    if (source.startsWith('@ironclad/') || source.startsWith('@tauri-apps/')) {
      return null;
    }

    try {
      const { path, suffix } = splitImportSuffix(source);
      const resolved = resolveWrapperImport(path);
      return this.resolve(`${resolved}${suffix}`, importer, { skipSelf: true });
    } catch {
      return null;
    }
  },
});

// https://vitejs.dev/config/
export default defineConfig({
  root: __dirname,
  envDir: resolve(__dirname, '../..'),
  envPrefix: ['VITE_', 'RIVET_'],
  publicDir: resolve(upstreamApp, 'public'),

  optimizeDeps: {
    exclude: ['@ironclad/rivet-core', '@ironclad/trivet'],
  },

  resolve: {
    preserveSymlinks: true,

    alias: [
      // === Tauri package shims (most specific first) ===
      // These must stay first so upstream Tauri imports are intercepted before any broader
      // alias rule can resolve them to the real desktop-only packages.
      { find: '@tauri-apps/api/app', replacement: resolve(shimDir, 'tauri-noop-shims.ts') },
      { find: '@tauri-apps/api/dialog', replacement: resolve(shimDir, 'tauri-apps-api-dialog.ts') },
      { find: '@tauri-apps/api/fs', replacement: resolve(shimDir, 'tauri-apps-api-fs.ts') },
      { find: '@tauri-apps/api/globalShortcut', replacement: resolve(shimDir, 'tauri-noop-shims.ts') },
      { find: '@tauri-apps/api/http', replacement: resolve(shimDir, 'tauri-apps-api-http.ts') },
      { find: '@tauri-apps/api/path', replacement: resolve(shimDir, 'tauri-apps-api-path.ts') },
      { find: '@tauri-apps/api/process', replacement: resolve(shimDir, 'tauri-noop-shims.ts') },
      { find: '@tauri-apps/api/shell', replacement: resolve(shimDir, 'tauri-apps-api-shell.ts') },
      { find: '@tauri-apps/api/updater', replacement: resolve(shimDir, 'tauri-noop-shims.ts') },
      { find: '@tauri-apps/api/window', replacement: resolve(shimDir, 'tauri-apps-api-window.ts') },
      { find: '@tauri-apps/api', replacement: resolve(shimDir, 'tauri-apps-api.ts') },

      // === Upstream module overrides (file-level aliases) ===
      // ^\.\.?\/ restricts to relative imports only, which lets us override upstream files with
      // generic names like settings or datasets without accidentally hijacking bare package imports.
      { find: /^\.\.?\/(?:.*\/)?tauri(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'utils/tauri.ts') },
      { find: /^\.\.?\/(?:.*\/)?ioProvider(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'utils/globals/ioProvider.ts') },
      { find: /^\.\.?\/(?:.*\/)?datasetProvider(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'utils/globals/datasetProvider.ts') },
      { find: /^\.\.?\/(?:.*\/)?settings(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'state/settings.ts') },
      { find: /^\.\.?\/(?:.*\/)?useExecutorSidecar(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useExecutorSidecar.ts') },
      { find: /^\.\.?\/(?:.*\/)?useGraphExecutor(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useGraphExecutor.ts') },
      { find: /^\.\.?\/(?:.*\/)?useRemoteDebugger(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useRemoteDebugger.ts') },
      { find: /^\.\.?\/(?:.*\/)?useRemoteExecutor(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useRemoteExecutor.ts') },
      { find: /^\.\.?\/(?:.*\/)?useLoadPackagePlugin(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useLoadPackagePlugin.ts') },
      { find: /^\.\.?\/(?:.*\/)?useSyncCurrentStateIntoOpenedProjects(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useSyncCurrentStateIntoOpenedProjects.ts') },
      { find: /^\.\.?\/(?:.*\/)?TauriNativeApi(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'model/native/TauriNativeApi.ts') },
      { find: /^\.\.?\/(?:.*\/)?TauriProjectReferenceLoader(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'model/TauriProjectReferenceLoader.ts') },
      { find: /^\.\.?\/(?:.*\/)?datasets(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'io/datasets.ts') },
      { find: /^\.\.?\/(?:.*\/)?TauriIOProvider(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'io/TauriIOProvider.ts') },

      // Vendored upstream code must resolve shared dependencies from wrapper/web/node_modules,
      // not from whatever nested node_modules the upstream packages would otherwise find.
      ...wrapperExactDependencyAliases,
      ...wrapperTargetedSubpathAliases,

      // === Upstream library path aliases (match upstream vite.config) ===
      { find: '@ironclad/rivet-core', replacement: resolve(__dirname, '../../rivet/packages/core/src/index.ts') },
      { find: '@ironclad/trivet', replacement: resolve(__dirname, '../../rivet/packages/trivet/src/index.ts') },
    ],
  },

  define: {
    'import.meta.env.VITE_HOSTED_MODE': JSON.stringify('true'),
  },

  build: {
    chunkSizeWarningLimit: 10000,
    outDir: webDistDir,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('gpt-tokenizer')) {
            return 'gpt-tokenizer';
          }
        },
      },
    },
  },

  plugins: [
    resolveBrowserSafeGoogleCoreModule(),
    resolveWrapperDependency(),
    react(),
    viteTsconfigPaths({ root: upstreamApp }),
    svgr({
      svgrOptions: {
        icon: true,
      },
    }),
    // Bad ESM
    // Ensure worker bundles land in wrapper/web/dist when Vite root points to upstream app.
    (monacoEditorPlugin as any).default({
      publicPath: 'monacoeditorwork',
      customDistPath: (_root: string, buildOutDir: string) => resolve(buildOutDir, 'monacoeditorwork'),
    }),
    topLevelAwait(),
    splitVendorChunkPlugin(),
  ],

  worker: {
    format: 'es',
  },

  server: {
    port: 5174,
    watch: {
      usePolling: true,
      interval: 300,
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:21889',
        ws: true,
        rewrite: (path) => path.replace(/^\/ws\/executor(\/internal)?/, ''),
      },
    },
  },
});
