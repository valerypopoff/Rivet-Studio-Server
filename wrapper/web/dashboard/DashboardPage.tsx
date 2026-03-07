import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { ToastContainer } from 'react-toastify';
import { WorkflowLibraryPanel } from './WorkflowLibraryPanel';
import { WORKFLOW_DASHBOARD_SIDEBAR_WIDTH } from './constants';

const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;

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
  const [activeProjectPath, setActiveProjectPath] = useState('');
  const [openProjectCount, setOpenProjectCount] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(() => parseInt(WORKFLOW_DASHBOARD_SIDEBAR_WIDTH, 10) || 300);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const handleOpenProject = useCallback((path: string, options?: { replaceCurrent?: boolean }) => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'open-project', path, replaceCurrent: Boolean(options?.replaceCurrent) },
      '*',
    );
  }, []);

  const handleSaveProject = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'save-project' }, '*');
  }, []);

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

  return (
    <div className="dashboard-page" style={{ ['--workflow-dashboard-sidebar-width' as string]: `${sidebarWidth}px` }}>
      <style>{styles}</style>
      {!sidebarCollapsed ? (
        <aside className="dashboard-sidebar">
          <WorkflowLibraryPanel
            onOpenProject={handleOpenProject}
            onSaveProject={handleSaveProject}
            activeProjectPath={activeProjectPath}
            onCollapse={() => setSidebarCollapsed(true)}
          />
          <div className="dashboard-sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize folders pane" />
        </aside>
      ) : null}
      <main className="dashboard-main">
        {openProjectCount === 0 ? (
          <div className="dashboard-empty-state">
            <div className="dashboard-empty-state-message">Open or create a workflow project in the left pane to start editing.</div>
          </div>
        ) : null}
        <iframe
          ref={iframeRef}
          src="/?editor"
          className={`dashboard-editor-frame ${openProjectCount === 0 ? 'dashboard-editor-frame-hidden' : ''}`}
        />
      </main>
      {sidebarCollapsed ? (
        <button type="button" className="dashboard-restore-sidebar-button" onClick={() => setSidebarCollapsed(false)}>
          Show folders
        </button>
      ) : null}
      <ToastContainer position="bottom-right" hideProgressBar newestOnTop />
    </div>
  );
};
