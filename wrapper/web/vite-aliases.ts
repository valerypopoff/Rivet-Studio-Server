import { resolve } from 'node:path';

export function createTauriShimAliases(shimDir: string) {
  return [
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
  ];
}

export function createModuleOverrideAliases(overrideDir: string) {
  return [
    { find: /^\.\.?\/(?:.*\/)?tauri(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'utils/tauri.ts') },
    { find: /^\.\.?\/(?:.*\/)?ioProvider(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'utils/globals/ioProvider.ts') },
    { find: /^\.\.?\/(?:.*\/)?settings(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'state/settings.ts') },
    { find: /^\.\.?\/(?:.*\/)?useContextMenu(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useContextMenu.ts') },
    { find: /^\.\.?\/(?:.*\/)?useCopyNodesHotkeys(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useCopyNodesHotkeys.ts') },
    { find: /^\.\.?\/(?:.*\/)?useSaveProject(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useSaveProject.ts') },
    { find: /^\.\.?\/(?:.*\/)?useExecutorSidecar(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useExecutorSidecar.ts') },
    { find: /^\.\.?\/(?:.*\/)?useGraphExecutor(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useGraphExecutor.ts') },
    { find: /^\.\.?\/(?:.*\/)?useRemoteDebugger(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useRemoteDebugger.ts') },
    { find: /^\.\.?\/(?:.*\/)?useRemoteExecutor(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useRemoteExecutor.ts') },
    { find: /^\.\.?\/(?:.*\/)?useWindowsHotkeysFix(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useWindowsHotkeysFix.tsx') },
    { find: /^\.\.?\/(?:.*\/)?useLoadPackagePlugin(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useLoadPackagePlugin.ts') },
    { find: /^\.\.?\/(?:.*\/)?useSyncCurrentStateIntoOpenedProjects(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useSyncCurrentStateIntoOpenedProjects.ts') },
    { find: /^\.\.?\/(?:.*\/)?TauriNativeApi(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'model/native/TauriNativeApi.ts') },
    { find: /^\.\.?\/(?:.*\/)?TauriProjectReferenceLoader(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'model/TauriProjectReferenceLoader.ts') },
    { find: /^\.\.?\/(?:.*\/)?datasets(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'io/datasets.ts') },
    { find: /^\.\.?\/(?:.*\/)?TauriIOProvider(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'io/TauriIOProvider.ts') },
  ];
}

export function createBrowserSubpathAliases(webDir: string) {
  return [
    { find: /^assemblyai$/, replacement: resolve(webDir, 'node_modules/assemblyai/dist/browser.mjs') },
    { find: /^@google\/genai$/, replacement: resolve(webDir, 'node_modules/@google/genai/dist/web/index.mjs') },
    { find: /^@google-cloud\/vertexai$/, replacement: resolve(webDir, 'shims/google-cloud-vertexai.ts') },
    { find: /^jsonpath-plus$/, replacement: resolve(webDir, 'node_modules/jsonpath-plus/dist/index-browser-esm.js') },
    { find: /^nanoid$/, replacement: resolve(webDir, 'node_modules/nanoid/index.browser.js') },
    { find: /^nanoid\/non-secure$/, replacement: resolve(webDir, 'node_modules/nanoid/non-secure/index.js') },
    { find: /^yaml$/, replacement: resolve(webDir, 'node_modules/yaml/browser/index.js') },
    { find: /^yaml\/util$/, replacement: resolve(webDir, 'node_modules/yaml/browser/dist/util.js') },
  ];
}
