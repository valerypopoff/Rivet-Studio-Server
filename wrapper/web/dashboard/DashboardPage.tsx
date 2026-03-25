import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { toast, ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { WorkflowLibraryPanel } from './WorkflowLibraryPanel';
import type { WorkflowProjectPathMove } from './types';
import {
  isEditorToDashboardEvent,
  isValidBridgeOrigin,
} from '../../shared/editor-bridge';
import { useEditorCommandQueue } from './useEditorCommandQueue';
import './DashboardPage.css';

const WORKFLOW_DASHBOARD_SIDEBAR_WIDTH = '300px';
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;
const SIDEBAR_COLLAPSE_DURATION_MS = 260;

const isSaveShortcutEvent = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  (event.code === 'KeyS' || event.key.toLowerCase() === 's');

type SidebarGhostState = {
  fromX: number;
  fromY: number;
  fromWidth: number;
  fromHeight: number;
  toX: number;
  toY: number;
  toWidth: number;
  toHeight: number;
  active: boolean;
} | null;

export const DashboardPage: FC = () => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const [openedProjectPath, setOpenedProjectPath] = useState('');
  const [activeWorkflowProjectPath, setActiveWorkflowProjectPath] = useState('');
  const [editorReady, setEditorReady] = useState(false);
  const [openProjectCount, setOpenProjectCount] = useState(0);
  const [projectSaveSequence, setProjectSaveSequence] = useState(0);
  const [lastSavedProjectPath, setLastSavedProjectPath] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(() => parseInt(WORKFLOW_DASHBOARD_SIDEBAR_WIDTH, 10) || 300);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sidebarAnimating, setSidebarAnimating] = useState(false);
  const [sidebarGhost, setSidebarGhost] = useState<SidebarGhostState>(null);

  const postEditorCommand = useEditorCommandQueue(iframeRef, editorReady);

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
    if (openProjectCount === 0) {
      setSidebarCollapsed(false);
      setSidebarAnimating(false);
      setSidebarGhost(null);
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
    if (!sidebarAnimating) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSidebarAnimating(false);
      setSidebarGhost(null);
    }, SIDEBAR_COLLAPSE_DURATION_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [sidebarAnimating]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (
        !isValidBridgeOrigin(event, iframeRef.current?.contentWindow ?? null) ||
        !isEditorToDashboardEvent(event.data)
      ) {
        return;
      }

      switch (event.data.type) {
        case 'editor-ready':
          setEditorReady(true);
          break;
        case 'project-opened':
          setOpenedProjectPath(event.data.path);
          setActiveWorkflowProjectPath(event.data.path);
          break;
        case 'active-project-path-changed':
          setOpenedProjectPath(event.data.path);
          setActiveWorkflowProjectPath(event.data.path);
          break;
        case 'open-project-count-changed':
          setOpenProjectCount(event.data.count);
          break;
        case 'project-saved':
          setLastSavedProjectPath(event.data.path);
          setProjectSaveSequence((prev) => prev + 1);
          break;
        case 'project-open-failed':
          toast.error(`Failed to open project: ${event.data.error}`);
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const showEditorLoading = !editorReady;
  const showSidebar = openProjectCount === 0 || !sidebarCollapsed;
  const showRestoreButton = openProjectCount > 0;

  const handleCollapseSidebar = useCallback(() => {
    const restoreButtonRect = restoreButtonRef.current?.getBoundingClientRect();

    if (restoreButtonRect) {
      setSidebarGhost({
        fromX: 0,
        fromY: 0,
        fromWidth: sidebarWidth,
        fromHeight: window.innerHeight,
        toX: restoreButtonRect.left,
        toY: restoreButtonRect.top,
        toWidth: restoreButtonRect.width,
        toHeight: restoreButtonRect.height,
        active: false,
      });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setSidebarGhost((prev) => prev ? { ...prev, active: true } : prev);
        });
      });
    }

    setSidebarAnimating(true);
    setSidebarCollapsed(true);
  }, [sidebarWidth]);

  const handleRestoreSidebar = useCallback(() => {
    setSidebarCollapsed(false);
    setSidebarAnimating(false);
    setSidebarGhost(null);
  }, []);

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
            lastSavedProjectPath={lastSavedProjectPath}
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
