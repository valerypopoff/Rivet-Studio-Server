import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { ToastContainer } from 'react-toastify';
import { WorkflowLibraryPanel } from './WorkflowLibraryPanel';
import { WORKFLOW_DASHBOARD_SIDEBAR_WIDTH } from './constants';
import type { WorkflowProjectPathMove } from './types';
import './DashboardPage.css';

const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;
const SAVE_SHORTCUT_DEBUG_PREFIX = '[hosted-save-shortcut][dashboard]';

type EditorCommand =
  | { type: 'open-project'; path: string; replaceCurrent: boolean }
  | { type: 'save-project' }
  | { type: 'workflow-paths-moved'; moves: WorkflowProjectPathMove[] };

export const DashboardPage: FC = () => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pendingEditorCommandRef = useRef<EditorCommand | null>(null);
  const [activeProjectPath, setActiveProjectPath] = useState('');
  const [editorReady, setEditorReady] = useState(false);
  const [openProjectCount, setOpenProjectCount] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(() => parseInt(WORKFLOW_DASHBOARD_SIDEBAR_WIDTH, 10) || 300);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const postEditorCommand = useCallback(
    (command: EditorCommand) => {
      if (!editorReady || !iframeRef.current?.contentWindow) {
        if (command.type === 'save-project') {
          console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} queueing save-project command`, {
            editorReady,
            hasIframeWindow: Boolean(iframeRef.current?.contentWindow),
          });
        }
        pendingEditorCommandRef.current = command;
        return;
      }

      if (command.type === 'save-project') {
        console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} posting save-project command to iframe`, {
          editorReady,
          hasIframeWindow: Boolean(iframeRef.current?.contentWindow),
        });
      }
      iframeRef.current.contentWindow.postMessage(command, '*');
    },
    [editorReady],
  );

  const handleOpenProject = useCallback((path: string, options?: { replaceCurrent?: boolean }) => {
    postEditorCommand({ type: 'open-project', path, replaceCurrent: Boolean(options?.replaceCurrent) });
  }, [postEditorCommand]);

  const handleSaveProject = useCallback(() => {
    postEditorCommand({ type: 'save-project' });
  }, [postEditorCommand]);

  const handleWorkflowPathsMoved = useCallback(
    (moves: WorkflowProjectPathMove[]) => {
      if (moves.length === 0) {
        return;
      }

      setActiveProjectPath((prev) => moves.find((move) => move.fromAbsolutePath === prev)?.toAbsolutePath ?? prev);
      postEditorCommand({ type: 'workflow-paths-moved', moves });
    },
    [postEditorCommand],
  );

  useEffect(() => {
    if (!editorReady || !pendingEditorCommandRef.current || !iframeRef.current?.contentWindow) {
      return;
    }

    if (pendingEditorCommandRef.current.type === 'save-project') {
      console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} flushing queued save-project command to iframe`, {
        editorReady,
      });
    }
    iframeRef.current.contentWindow.postMessage(pendingEditorCommandRef.current, '*');
    pendingEditorCommandRef.current = null;
  }, [editorReady]);

  useEffect(() => {
    if (openProjectCount === 0) {
      setSidebarCollapsed(false);
    }
  }, [openProjectCount]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isSaveShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's';
      const isIframeFocused = document.activeElement === iframeRef.current;
      if (!isSaveShortcut || !editorReady || openProjectCount === 0) {
        if (isSaveShortcut) {
          console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} ignoring keydown`, {
            editorReady,
            openProjectCount,
            isIframeFocused,
            activeElementTag: document.activeElement?.tagName ?? null,
            targetTag: (event.target as HTMLElement | null)?.tagName ?? null,
            defaultPrevented: event.defaultPrevented,
            repeat: event.repeat,
          });
        }
        return;
      }

      console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} observed save shortcut`, {
        editorReady,
        openProjectCount,
        isIframeFocused,
        activeElementTag: document.activeElement?.tagName ?? null,
        targetTag: (event.target as HTMLElement | null)?.tagName ?? null,
        defaultPrevented: event.defaultPrevented,
        repeat: event.repeat,
      });

      if (isIframeFocused) {
        console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} letting iframe handle save shortcut`);
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} handling save shortcut in dashboard and relaying to iframe`);
      handleSaveProject();
    };

    document.addEventListener('keydown', handler, true);
    return () => {
      document.removeEventListener('keydown', handler, true);
    };
  }, [editorReady, handleSaveProject, openProjectCount]);

  useEffect(() => {
    if (sidebarCollapsed) {
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, event.clientX)));
    };

    const stopResize = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopResize);
    };

    const handleResizeStart = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.dashboard-sidebar-resizer')) {
        return;
      }

      event.preventDefault();
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', stopResize);
    };

    window.addEventListener('mousedown', handleResizeStart);

    return () => {
      window.removeEventListener('mousedown', handleResizeStart);
      stopResize();
    };
  }, [sidebarCollapsed]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === 'editor-ready') {
        setEditorReady(true);
        return;
      }

      if (event.data?.type === 'project-opened' && typeof event.data.path === 'string') {
        setActiveProjectPath(event.data.path);
        return;
      }

      if (event.data?.type === 'active-project-path-changed' && typeof event.data.path === 'string') {
        setActiveProjectPath(event.data.path);
        return;
      }

      if (event.data?.type === 'open-project-count-changed' && typeof event.data.count === 'number') {
        setOpenProjectCount(event.data.count);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const showEditorLoading = !editorReady;

  return (
    <div className="dashboard-page" style={{ ['--workflow-dashboard-sidebar-width' as string]: `${sidebarWidth}px` }}>
      {!sidebarCollapsed ? (
        <aside className="dashboard-sidebar">
          <WorkflowLibraryPanel
            onOpenProject={handleOpenProject}
            onSaveProject={handleSaveProject}
            onWorkflowPathsMoved={handleWorkflowPathsMoved}
            activeProjectPath={activeProjectPath}
            editorReady={editorReady}
            onCollapse={openProjectCount === 0 ? undefined : () => setSidebarCollapsed(true)}
          />
          <div className="dashboard-sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize folders pane" />
        </aside>
      ) : null}
      <main className="dashboard-main">
        {showEditorLoading ? (
          <div className="dashboard-editor-loading">
            <div className="dashboard-editor-loading-message">Loading editor... Project open actions will be available in a moment.</div>
          </div>
        ) : null}
        {openProjectCount === 0 ? (
          <div className="dashboard-empty-state">
            <div className="dashboard-empty-state-message">Open or create a Rivet project in the left pane to start editing.</div>
          </div>
        ) : null}
        <iframe
          ref={iframeRef}
          src="/?editor"
          onLoad={() => setEditorReady(false)}
          className={`dashboard-editor-frame ${openProjectCount === 0 ? 'dashboard-editor-frame-hidden' : ''}`}
        />
      </main>
      {sidebarCollapsed && openProjectCount > 0 ? (
        <button type="button" className="dashboard-restore-sidebar-button" onClick={() => setSidebarCollapsed(false)}>
          Show projects
        </button>
      ) : null}
      <ToastContainer position="bottom-right" hideProgressBar newestOnTop />
    </div>
  );
};
