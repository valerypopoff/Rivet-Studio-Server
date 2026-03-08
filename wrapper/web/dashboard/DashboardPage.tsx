import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { ToastContainer } from 'react-toastify';
import { WorkflowLibraryPanel } from './WorkflowLibraryPanel';
import { WORKFLOW_DASHBOARD_SIDEBAR_WIDTH } from './constants';

const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;

type EditorCommand =
  | { type: 'open-project'; path: string; replaceCurrent: boolean }
  | { type: 'save-project' };

const styles = `
  .dashboard-page {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    display: flex;
  }

  .dashboard-page .dashboard-sidebar {
    position: relative;
    flex: 0 0 var(--workflow-dashboard-sidebar-width);
    width: var(--workflow-dashboard-sidebar-width);
    height: 100vh;
    background: var(--grey-darkest);
    border-right: 1px solid var(--grey);
    min-width: 0;
  }

  .dashboard-page .dashboard-sidebar-resizer {
    position: absolute;
    top: 0;
    right: -3px;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    z-index: 2;
  }

  .dashboard-page .dashboard-sidebar-resizer:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .dashboard-page .dashboard-editor-frame {
    flex: 1;
    border: none;
    width: 0;
    height: 100vh;
  }

  .dashboard-page .dashboard-editor-frame.dashboard-editor-frame-hidden {
    opacity: 0;
    pointer-events: none;
  }

  .dashboard-page .dashboard-main {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 100vh;
    background: var(--grey-darker);
  }

  .dashboard-page .dashboard-editor-frame {
    width: 100%;
  }

  .dashboard-page .dashboard-empty-state {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    color: var(--grey-light);
    text-align: center;
    background: var(--grey-darker);
  }

  .dashboard-page .dashboard-empty-state-message {
    max-width: 420px;
    font-size: 14px;
    line-height: 1.6;
  }

  .dashboard-page .dashboard-editor-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    color: var(--grey-lightest);
    text-align: center;
    background: rgba(13, 17, 23, 0.78);
    z-index: 5;
  }

  .dashboard-page .dashboard-editor-loading-message {
    max-width: 420px;
    font-size: 14px;
    line-height: 1.6;
  }

  .dashboard-page .dashboard-restore-sidebar-button {
    position: fixed;
    left: 12px;
    bottom: 12px;
    z-index: 400;
    border: 1px solid var(--grey);
    border-radius: 8px;
    background: var(--grey-darkest);
    color: var(--grey-lightest);
    padding: 8px 12px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
  }

  .dashboard-page .dashboard-restore-sidebar-button:hover {
    background: rgba(255, 255, 255, 0.08);
  }
`;

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
        pendingEditorCommandRef.current = command;
        return;
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

  useEffect(() => {
    if (!editorReady || !pendingEditorCommandRef.current || !iframeRef.current?.contentWindow) {
      return;
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
      if (!isSaveShortcut || !editorReady || openProjectCount === 0) {
        return;
      }

      if (document.activeElement === iframeRef.current) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
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
      <style>{styles}</style>
      {!sidebarCollapsed ? (
        <aside className="dashboard-sidebar">
          <WorkflowLibraryPanel
            onOpenProject={handleOpenProject}
            onSaveProject={handleSaveProject}
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
