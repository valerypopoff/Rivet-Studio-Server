// Override for rivet/packages/app/src/hooks/useWindowsHotkeysFix.tsx
// Hosted mode already handles save inside the iframe, so Windows keyup fallback
// must not trigger a second save.

import { useEffect } from 'react';
import { type MenuIds, useRunMenuCommand } from '../../../../rivet/packages/app/src/hooks/useMenuCommands.js';
import * as tauriUtils from '../utils/tauri';

interface HotkeyFixWindow extends Window {
  __tauri_hotkey?: boolean;
}
declare let window: HotkeyFixWindow;

const isWindowsPlatform = typeof navigator !== 'undefined' && navigator.userAgent.includes('Win64');

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

  // @see https://github.com/Ironclad/rivet/issues/261
  useEffect(() => {
    if (typeof window === 'undefined' || !isWindowsPlatform || window.__tauri_hotkey) {
      return;
    }

    const onKeyUp = ({ key, ctrlKey, shiftKey }: KeyboardEvent) => {
      const code = `${ctrlKey ? 'CmdOrCtrl+' : ''}${shiftKey ? 'Shift+' : ''}${key.toUpperCase()}`;
      const codeToMenuId: Record<string, MenuIds> = {
        F5: 'remote_debugger',
        'CmdOrCtrl+Shift+O': 'load_recording',
        'CmdOrCtrl+N': 'new_project',
        'CmdOrCtrl+O': 'open_project',
        'CmdOrCtrl+S': 'save_project',
        'CmdOrCtrl+Shift+E': 'export_graph',
        'CmdOrCtrl+Shift+I': 'import_graph',
        'CmdOrCtrl+Shift+S': 'save_project_as',
        'CmdOrCtrl+ENTER': 'run',
      };
      const menuId = codeToMenuId[code];
      if (!menuId) {
        return;
      }

      if (menuId === 'save_project' && isHostedMode()) {
        return;
      }

      runMenuCommandImpl(menuId);
    };

    window.__tauri_hotkey = true;
    window.addEventListener('keyup', onKeyUp);

    return () => {
      window.removeEventListener('keyup', onKeyUp);
      window.__tauri_hotkey = false;
    };
  }, [runMenuCommandImpl]);

  return isWindowsPlatform;
};
