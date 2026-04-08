import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { WorkflowLibraryPanel } from './WorkflowLibraryPanel';
import type { WorkflowProjectPathMove } from './types';
import { useEditorCommandQueue } from './useEditorCommandQueue';
import { focusIframeElement } from './editorBridgeFocus';
import { useDashboardSidebar } from './useDashboardSidebar';
import { useEditorBridgeEvents } from './useEditorBridgeEvents';
import './DashboardPage.css';

const WORKFLOW_DASHBOARD_SIDEBAR_WIDTH = '300px';
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;
const SIDEBAR_COLLAPSE_DURATION_MS = 260;

export const DashboardPage: FC = () => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const [openedProjectPath, setOpenedProjectPath] = useState('');
  const [activeWorkflowProjectPath, setActiveWorkflowProjectPath] = useState('');
  const [editorReady, setEditorReady] = useState(false);
  const [openProjectCount, setOpenProjectCount] = useState(0);
  const [projectSaveSequence, setProjectSaveSequence] = useState(0);
  const postEditorCommand = useEditorCommandQueue(iframeRef, editorReady);
  const {
    handleCollapseSidebar,
    handleRestoreSidebar,
    showRestoreButton,
    showSidebar,
    sidebarCollapsed,
    sidebarGhost,
    sidebarResizing,
    sidebarWidth,
  } = useDashboardSidebar({
    collapseDurationMs: SIDEBAR_COLLAPSE_DURATION_MS,
    maxWidth: MAX_SIDEBAR_WIDTH,
    minWidth: MIN_SIDEBAR_WIDTH,
    openProjectCount,
    restoreButtonRef,
  });

  const handleOpenProject = useCallback((path: string, options?: { replaceCurrent?: boolean }) => {
    postEditorCommand({ type: 'open-project', path, replaceCurrent: Boolean(options?.replaceCurrent) });
  }, [postEditorCommand]);

  const handleOpenRecording = useCallback(
    (recordingId: string, options?: { replaceCurrent?: boolean }) => {
      postEditorCommand({
        type: 'open-recording',
        recordingId,
        replaceCurrent: Boolean(options?.replaceCurrent),
      });
    },
    [postEditorCommand],
  );

  const handleSaveProject = useCallback(() => {
    postEditorCommand({ type: 'save-project' });
  }, [postEditorCommand]);

  const focusEditorFrame = useCallback(() => {
    focusIframeElement(iframeRef.current);
  }, []);

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
  useEditorBridgeEvents({
    activeWorkflowProjectPath,
    editorReady,
    focusEditorFrame,
    handleSaveProject,
    iframeRef,
    onActiveWorkflowProjectPathChange: (path) => {
      setOpenedProjectPath(path);
      setActiveWorkflowProjectPath(path);
    },
    onEditorReady: () => {
      setEditorReady(true);
    },
    onOpenProjectCountChange: (count) => {
      setOpenProjectCount(count);
    },
    onProjectOpenFailed: () => {
    },
    onProjectOpened: (path) => {
      setOpenedProjectPath(path);
      setActiveWorkflowProjectPath(path);
    },
    onProjectSaved: () => {
      setProjectSaveSequence((prev) => prev + 1);
    },
  });

  const showEditorLoading = !editorReady;

  return (
    <div className="dashboard-page" style={{ ['--workflow-dashboard-sidebar-width' as string]: `${sidebarWidth}px` }}>
      {showEditorLoading ? (
        <div className="dashboard-app-loading">
          <div className="dashboard-editor-loading-spinner" aria-hidden="true" />
          <div className="dashboard-editor-loading-message">Loading...</div>
        </div>
      ) : null}
      {showSidebar ? (
        <aside className="dashboard-sidebar">
          <WorkflowLibraryPanel
            onOpenProject={handleOpenProject}
            onOpenRecording={handleOpenRecording}
            onSaveProject={handleSaveProject}
            onDeleteProject={handleDeleteProject}
            onWorkflowPathsMoved={handleWorkflowPathsMoved}
            onActiveWorkflowProjectPathChange={setActiveWorkflowProjectPath}
            openedProjectPath={openedProjectPath}
            editorReady={editorReady}
            projectSaveSequence={projectSaveSequence}
            onCollapse={openProjectCount === 0 ? undefined : handleCollapseSidebar}
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
      {sidebarGhost ? (
        <div
          aria-hidden="true"
          className={`dashboard-sidebar-ghost${sidebarGhost.active ? ' dashboard-sidebar-ghost-active' : ''}`}
          style={{
            left: `${sidebarGhost.fromX}px`,
            top: `${sidebarGhost.fromY}px`,
            width: `${sidebarGhost.fromWidth}px`,
            height: `${sidebarGhost.fromHeight}px`,
            ['--dashboard-sidebar-ghost-translate-x' as string]: `${sidebarGhost.toX - sidebarGhost.fromX}px`,
            ['--dashboard-sidebar-ghost-translate-y' as string]: `${sidebarGhost.toY - sidebarGhost.fromY}px`,
            ['--dashboard-sidebar-ghost-scale-x' as string]: `${sidebarGhost.toWidth / Math.max(sidebarGhost.fromWidth, 1)}`,
            ['--dashboard-sidebar-ghost-scale-y' as string]: `${sidebarGhost.toHeight / Math.max(sidebarGhost.fromHeight, 1)}`,
          }}
        />
      ) : null}
      {showRestoreButton ? (
        <button
          ref={restoreButtonRef}
          type="button"
          className={`dashboard-restore-sidebar-button${sidebarCollapsed ? ' dashboard-restore-sidebar-button-visible' : ''}`}
          onClick={handleRestoreSidebar}
        >
          Show main panel
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
