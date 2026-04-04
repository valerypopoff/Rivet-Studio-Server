import { useEffect } from 'react';
import { useSaveProject } from './useSaveProject.js';
import { window } from '@tauri-apps/api';
import { match } from 'ts-pattern';
import { useLoadProjectWithFileBrowser } from '../../../../rivet/packages/app/src/hooks/useLoadProjectWithFileBrowser.js';
import { settingsModalOpenState } from '../../../../rivet/packages/app/src/components/SettingsModal.js';
import { graphState } from '../../../../rivet/packages/app/src/state/graph.js';
import { useLoadRecording } from '../../../../rivet/packages/app/src/hooks/useLoadRecording.js';
import { type WebviewWindow } from '@tauri-apps/api/window';
import { ioProvider } from '../../../../rivet/packages/app/src/utils/globals.js';
import { helpModalOpenState, newProjectModalOpenState } from '../../../../rivet/packages/app/src/state/ui';
import { useToggleRemoteDebugger } from '../../../../rivet/packages/app/src/components/DebuggerConnectPanel';
import { lastRunDataByNodeState } from '../../../../rivet/packages/app/src/state/dataFlow';
import { useImportGraph } from '../../../../rivet/packages/app/src/hooks/useImportGraph';
import { useAtom, useSetAtom } from 'jotai';

export type MenuIds =
  | 'settings'
  | 'quit'
  | 'new_project'
  | 'open_project'
  | 'save_project'
  | 'save_project_as'
  | 'export_graph'
  | 'import_graph'
  | 'run'
  | 'load_recording'
  | 'remote_debugger'
  | 'toggle_devtools'
  | 'clear_outputs'
  | 'get_help';

const handlerState: {
  handler: (e: { payload: MenuIds }) => void;
} = { handler: () => {} };

let mainWindow: WebviewWindow | null = null;

try {
  mainWindow = window.getCurrent();
  void mainWindow.onMenuClicked((e) => {
    handlerState.handler(e as { payload: MenuIds });
  });
} catch {
  mainWindow = null;
}

export function useRunMenuCommand() {
  return (command: MenuIds) => {
    handlerState.handler({ payload: command });
  };
}

export function useMenuCommands(
  options: {
    onRunGraph?: () => void;
  } = {},
) {
  const [graphData] = useAtom(graphState);
  const { saveProject, saveProjectAs } = useSaveProject();
  const setNewProjectModalOpen = useSetAtom(newProjectModalOpenState);
  const loadProject = useLoadProjectWithFileBrowser();
  const setSettingsOpen = useSetAtom(settingsModalOpenState);
  const { loadRecording } = useLoadRecording();
  const toggleRemoteDebugger = useToggleRemoteDebugger();
  const setLastRunData = useSetAtom(lastRunDataByNodeState);
  const importGraph = useImportGraph();
  const setHelpModalOpen = useSetAtom(helpModalOpenState);

  useEffect(() => {
    const handler: (e: { payload: MenuIds }) => void = ({ payload }) => {
      match(payload as MenuIds)
        .with('settings', () => {
          setSettingsOpen(true);
        })
        .with('quit', () => {
          void mainWindow?.close();
        })
        .with('new_project', () => {
          setNewProjectModalOpen(true);
        })
        .with('open_project', () => {
          loadProject();
        })
        .with('save_project', () => {
          saveProject();
        })
        .with('save_project_as', () => {
          saveProjectAs();
        })
        .with('export_graph', () => {
          void ioProvider.saveGraphData(graphData);
        })
        .with('import_graph', () => {
          importGraph();
        })
        .with('run', () => {
          options.onRunGraph?.();
        })
        .with('load_recording', () => {
          loadRecording();
        })
        .with('remote_debugger', () => {
          toggleRemoteDebugger();
        })
        .with('toggle_devtools', () => {})
        .with('clear_outputs', () => {
          setLastRunData({});
        })
        .with('get_help', () => {
          setHelpModalOpen(true);
        })
        .exhaustive();
    };

    const prevHandler = handlerState.handler;
    handlerState.handler = handler;

    return () => {
      handlerState.handler = prevHandler;
    };
  }, [
    saveProject,
    saveProjectAs,
    loadProject,
    setSettingsOpen,
    graphData,
    options,
    loadRecording,
    importGraph,
    toggleRemoteDebugger,
    setLastRunData,
    setNewProjectModalOpen,
    setHelpModalOpen,
  ]);
}
