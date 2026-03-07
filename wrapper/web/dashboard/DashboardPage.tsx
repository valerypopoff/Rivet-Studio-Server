import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { ToastContainer } from 'react-toastify';
import { WorkflowLibraryPanel } from './WorkflowLibraryPanel';
import { WORKFLOW_DASHBOARD_SIDEBAR_WIDTH } from './constants';

const styles = `
  .dashboard-page {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    display: flex;
  }

  .dashboard-page .dashboard-sidebar {
    flex: 0 0 ${WORKFLOW_DASHBOARD_SIDEBAR_WIDTH};
    width: ${WORKFLOW_DASHBOARD_SIDEBAR_WIDTH};
    height: 100vh;
    background: var(--grey-darkest);
    border-right: 1px solid var(--grey);
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
`;

export const DashboardPage: FC = () => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [activeProjectPath, setActiveProjectPath] = useState('');
  const [openProjectCount, setOpenProjectCount] = useState(0);

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
    <div className="dashboard-page">
      <style>{styles}</style>
      <aside className="dashboard-sidebar">
        <WorkflowLibraryPanel
          onOpenProject={handleOpenProject}
          onSaveProject={handleSaveProject}
          activeProjectPath={activeProjectPath}
        />
      </aside>
      <main className="dashboard-main">
        {openProjectCount === 0 ? (
          <div className="dashboard-empty-state">
            <div className="dashboard-empty-state-message">Open a workflow project from the left pane to start editing.</div>
          </div>
        ) : null}
        <iframe
          ref={iframeRef}
          src="/?editor"
          className={`dashboard-editor-frame ${openProjectCount === 0 ? 'dashboard-editor-frame-hidden' : ''}`}
        />
      </main>
      <ToastContainer position="bottom-right" hideProgressBar newestOnTop />
    </div>
  );
};
