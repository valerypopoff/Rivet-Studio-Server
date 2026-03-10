import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { WorkflowLibraryPanel } from './WorkflowLibraryPanel';
import type { WorkflowProjectPathMove } from './types';
import './DashboardPage.css';

const WORKFLOW_DASHBOARD_SIDEBAR_WIDTH = '300px';
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;

const isSaveShortcutEvent = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  (event.code === 'KeyS' || event.key.toLowerCase() === 's');

type EditorCommand =
  | { type: 'open-project'; path: string; replaceCurrent: boolean }
  | { type: 'save-project' }
  | { type: 'delete-workflow-project'; path: string }
  | { type: 'workflow-paths-moved'; moves: WorkflowProjectPathMove[] };

export const DashboardPage: FC = () => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pendingEditorCommandRef = useRef<EditorCommand | null>(null);
  const [openedProjectPath, setOpenedProjectPath] = useState('');
  const [activeWorkflowProjectPath, setActiveWorkflowProjectPath] = useState('');
  const [editorReady, setEditorReady] = useState(false);
  const [openProjectCount, setOpenProjectCount] = useState(0);
  const [projectSaveSequence, setProjectSaveSequence] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(() => parseInt(WORKFLOW_DASHBOARD_SIDEBAR_WIDTH, 10) || 300);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);

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

  const handleDeleteProject = useCallback((path: string) => {
    setOpenedProjectPath((prev) => (prev === path ? '' : prev));
    postEditorCommand({ type: 'delete-workflow-project', path });
  }, [postEditorCommand]);

  const handleWorkflowPathsMoved = useCallback(
    (moves: WorkflowProjectPathMove[]) => {
      if (moves.length === 0) {
        return;
      }

      setOpenedProjectPath((prev) => moves.find((move) => move.fromAbsolutePath === prev)?.toAbsolutePath ?? prev);
      postEditorCommand({ type: 'workflow-paths-moved', moves });
    },
    [postEditorCommand],
  );

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
      const isIframeFocused = document.activeElement === iframeRef.current;
      if (!isSaveShortcutEvent(event) || event.defaultPrevented || !editorReady) {
        return;
      }

      if (isIframeFocused) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (!activeWorkflowProjectPath) {
        return;
      }

      handleSaveProject();
    };

    window.addEventListener('keydown', handler, true);
    document.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      document.removeEventListener('keydown', handler, true);
    };
  }, [activeWorkflowProjectPath, editorReady, handleSaveProject]);

  useEffect(() => {
    if (sidebarCollapsed) {
      setSidebarResizing(false);
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, event.clientX)));
    };

    const stopResize = () => {
      setSidebarResizing(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopResize);
    };

    const handleResizeStart = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.dashboard-sidebar-resizer')) {
        return;
      }

      event.preventDefault();
      setSidebarResizing(true);
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
        setOpenedProjectPath(event.data.path);
        return;
      }

      if (event.data?.type === 'active-project-path-changed' && typeof event.data.path === 'string') {
        setOpenedProjectPath(event.data.path);
        return;
      }

      if (event.data?.type === 'open-project-count-changed' && typeof event.data.count === 'number') {
        setOpenProjectCount(event.data.count);
        return;
      }

      if (event.data?.type === 'project-saved' && typeof event.data.path === 'string') {
        setProjectSaveSequence((prev) => prev + 1);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const showEditorLoading = !editorReady;

  return (
    <div className="dashboard-page" style={{ ['--workflow-dashboard-sidebar-width' as string]: `${sidebarWidth}px` }}>
      {showEditorLoading ? (
        <div className="dashboard-app-loading">
          <div className="dashboard-editor-loading-spinner" aria-hidden="true" />
          <div className="dashboard-editor-loading-message">Loading...</div>
        </div>
      ) : null}
      {!sidebarCollapsed ? (
        <aside className="dashboard-sidebar">
          <WorkflowLibraryPanel
            onOpenProject={handleOpenProject}
            onSaveProject={handleSaveProject}
            onDeleteProject={handleDeleteProject}
            onWorkflowPathsMoved={handleWorkflowPathsMoved}
            onActiveWorkflowProjectPathChange={setActiveWorkflowProjectPath}
            openedProjectPath={openedProjectPath}
            editorReady={editorReady}
            projectSaveSequence={projectSaveSequence}
            onCollapse={openProjectCount === 0 ? undefined : () => setSidebarCollapsed(true)}
          />
          <div className="dashboard-sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize folders pane" />
        </aside>
      ) : null}
      <main className="dashboard-main">
        {openProjectCount === 0 ? (
          <div className="dashboard-empty-state">
            <div className="dashboard-empty-state-message">Open or create a Rivet project in the left pane to start editing.</div>
          </div>
        ) : null}
        <iframe
          ref={iframeRef}
          src="/?editor"
          onLoad={() => setEditorReady(false)}
          className={`dashboard-editor-frame ${openProjectCount === 0 ? 'dashboard-editor-frame-hidden' : ''}${sidebarResizing ? ' dashboard-editor-frame-resizing' : ''}`}
        />
      </main>
      {sidebarResizing ? <div className="dashboard-resize-overlay" aria-hidden="true" /> : null}
      {sidebarCollapsed && openProjectCount > 0 ? (
        <button type="button" className="dashboard-restore-sidebar-button" onClick={() => setSidebarCollapsed(false)}>
          Show projects
        </button>
      ) : null}
      <ToastContainer
        position="bottom-center"
        hideProgressBar
        newestOnTop
        closeButton={false}
        icon={false}
        toastClassName="dashboard-toast"
        bodyClassName="dashboard-toast-body"
      />
    </div>
  );
};
