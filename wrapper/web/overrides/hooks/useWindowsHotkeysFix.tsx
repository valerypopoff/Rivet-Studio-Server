// Override for rivet/packages/app/src/hooks/useWindowsHotkeysFix.tsx
// Hosted mode already handles save inside the iframe, so the Windows fallback
// must not trigger a second save.

import { useEffect } from 'react';
import { type MenuIds, useRunMenuCommand } from '../../../../rivet/packages/app/src/hooks/useMenuCommands.js';
import * as tauriUtils from '../utils/tauri';

interface HotkeyFixWindow extends Window {
  __rivetWindowsHotkeysCleanup?: () => void;
}
declare let window: HotkeyFixWindow;

const isWindowsPlatform =
  typeof navigator !== 'undefined' && /Windows|Win32|Win64|WOW64/i.test(`${navigator.userAgent} ${navigator.platform}`);

const shortcutToMenuId: Record<string, MenuIds> = {
  F5: 'remote_debugger',
  'CmdOrCtrl+Shift+O': 'load_recording',
  'CmdOrCtrl+N': 'new_project',
  'CmdOrCtrl+O': 'open_project',
  'CmdOrCtrl+S': 'save_project',
  'CmdOrCtrl+Shift+E': 'export_graph',
  'CmdOrCtrl+Shift+S': 'save_project_as',
  'CmdOrCtrl+ENTER': 'run',
};

const hotkeyListenerOptions = { capture: true };

const isHostedMode = () => {
  if (typeof (tauriUtils as { isHostedMode?: () => boolean }).isHostedMode === 'function') {
    return (tauriUtils as { isHostedMode: () => boolean }).isHostedMode();
  }

  const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return viteEnv?.VITE_HOSTED_MODE === 'true';
};

/**
 * Applies a keyboard shortcut fix for Windows platform.
 */
export const useWindowsHotkeysFix = () => {
  const runMenuCommandImpl = useRunMenuCommand();

  // Keep the Windows shortcut workaround local to hosted keyboard handling.
  useEffect(() => {
    if (typeof window === 'undefined' || !isWindowsPlatform) {
      return;
    }

    window.__rivetWindowsHotkeysCleanup?.();

    const onKeyDown = (event: KeyboardEvent) => {
      const { key, ctrlKey, metaKey, shiftKey } = event;
      const code = `${ctrlKey || metaKey ? 'CmdOrCtrl+' : ''}${shiftKey ? 'Shift+' : ''}${key.toUpperCase()}`;
      const menuId = shortcutToMenuId[code];
      if (!menuId) {
        return;
      }

      event.preventDefault();

      if (menuId === 'save_project' && isHostedMode()) {
        // Let EditorMessageBridge own hosted save so the Windows fallback cannot double-save.
        return;
      }

      event.stopPropagation();

      if (event.repeat) {
        return;
      }

      runMenuCommandImpl(menuId);
    };

    window.addEventListener('keydown', onKeyDown, hotkeyListenerOptions);

    const cleanup = () => {
      window.removeEventListener('keydown', onKeyDown, hotkeyListenerOptions);
    };

    window.__rivetWindowsHotkeysCleanup = cleanup;

    return () => {
      if (window.__rivetWindowsHotkeysCleanup === cleanup) {
        cleanup();
        delete window.__rivetWindowsHotkeysCleanup;
      }
    };
  }, [runMenuCommandImpl]);

  return isWindowsPlatform;
};
