import { defineConfig, splitVendorChunkPlugin } from 'vite';
import type { PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import svgr from 'vite-plugin-svgr';
import monacoEditorPlugin from 'vite-plugin-monaco-editor';
import topLevelAwait from 'vite-plugin-top-level-await';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const upstreamApp = resolve(__dirname, '../../rivet/packages/app');
const upstreamAppSrc = resolve(upstreamApp, 'src');
const shimDir = resolve(__dirname, 'shims');
const overrideDir = resolve(__dirname, 'overrides');

// https://vitejs.dev/config/
export default defineConfig({
  root: upstreamApp,

  optimizeDeps: {
    exclude: ['@ironclad/rivet-core', '@ironclad/trivet'],
  },

  resolve: {
    preserveSymlinks: true,

    alias: [
      // === Tauri package shims (most specific first) ===
      { find: '@tauri-apps/api/app', replacement: resolve(shimDir, 'tauri-apps-api-app.ts') },
      { find: '@tauri-apps/api/dialog', replacement: resolve(shimDir, 'tauri-apps-api-dialog.ts') },
      { find: '@tauri-apps/api/fs', replacement: resolve(shimDir, 'tauri-apps-api-fs.ts') },
      { find: '@tauri-apps/api/globalShortcut', replacement: resolve(shimDir, 'tauri-apps-api-globalShortcut.ts') },
      { find: '@tauri-apps/api/http', replacement: resolve(shimDir, 'tauri-apps-api-http.ts') },
      { find: '@tauri-apps/api/path', replacement: resolve(shimDir, 'tauri-apps-api-path.ts') },
      { find: '@tauri-apps/api/process', replacement: resolve(shimDir, 'tauri-apps-api-process.ts') },
      { find: '@tauri-apps/api/shell', replacement: resolve(shimDir, 'tauri-apps-api-shell.ts') },
      { find: '@tauri-apps/api/tauri', replacement: resolve(shimDir, 'tauri-apps-api-tauri.ts') },
      { find: '@tauri-apps/api/updater', replacement: resolve(shimDir, 'tauri-apps-api-updater.ts') },
      { find: '@tauri-apps/api/window', replacement: resolve(shimDir, 'tauri-apps-api-window.ts') },
      { find: '@tauri-apps/api', replacement: resolve(shimDir, 'tauri-apps-api.ts') },

      // === Upstream module overrides (file-level aliases) ===
      // ^\.\.?\/ restricts to relative imports only (safe for generic names like settings/datasets)
      { find: /^\.\.?\/(?:.*\/)?tauri(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'utils/tauri.ts') },
      { find: /^\.\.?\/(?:.*\/)?ioProvider(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'utils/globals/ioProvider.ts') },
      { find: /^\.\.?\/(?:.*\/)?datasetProvider(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'utils/globals/datasetProvider.ts') },
      { find: /^\.\.?\/(?:.*\/)?settings(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'state/settings.ts') },
      { find: /^\.\.?\/(?:.*\/)?useExecutorSidecar(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useExecutorSidecar.ts') },
      { find: /^\.\.?\/(?:.*\/)?useGraphExecutor(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useGraphExecutor.ts') },
      { find: /^\.\.?\/(?:.*\/)?useRemoteDebugger(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useRemoteDebugger.ts') },
      { find: /^\.\.?\/(?:.*\/)?useRemoteExecutor(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useRemoteExecutor.ts') },
      { find: /^\.\.?\/(?:.*\/)?useLoadPackagePlugin(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useLoadPackagePlugin.ts') },
      { find: /^\.\.?\/(?:.*\/)?TauriNativeApi(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'model/native/TauriNativeApi.ts') },
      { find: /^\.\.?\/(?:.*\/)?TauriProjectReferenceLoader(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'model/TauriProjectReferenceLoader.ts') },
      { find: /^\.\.?\/(?:.*\/)?datasets(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'io/datasets.ts') },
      { find: /^\.\.?\/(?:.*\/)?TauriIOProvider(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'io/TauriIOProvider.ts') },

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
    outDir: resolve(__dirname, 'dist'),
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
    react(),
    viteTsconfigPaths({ root: upstreamApp }),
    svgr({
      svgrOptions: {
        icon: true,
      },
    }),
    // Bad ESM
    (monacoEditorPlugin as any).default({}),
    topLevelAwait(),
    splitVendorChunkPlugin(),
  ],

  worker: {
    format: 'es',
  },

  server: {
    port: 5174,
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
