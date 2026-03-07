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
`;

export const DashboardPage: FC = () => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [activeProjectPath, setActiveProjectPath] = useState('');

  const handleOpenProject = useCallback((path: string) => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'open-project', path }, '*');
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === 'project-opened' && typeof event.data.path === 'string') {
        setActiveProjectPath(event.data.path);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <div className="dashboard-page">
      <style>{styles}</style>
      <aside className="dashboard-sidebar">
        <WorkflowLibraryPanel onOpenProject={handleOpenProject} activeProjectPath={activeProjectPath} />
      </aside>
      <iframe ref={iframeRef} src="/?editor" className="dashboard-editor-frame" />
      <ToastContainer position="bottom-right" hideProgressBar newestOnTop />
    </div>
  );
};
