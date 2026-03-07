import type { FC, PropsWithChildren } from 'react';
import { WorkflowLibraryPanel } from './WorkflowLibraryPanel';
import { WORKFLOW_DASHBOARD_SIDEBAR_WIDTH } from './constants';

const styles = `
  .workflow-dashboard-shell {
    --workflow-dashboard-sidebar-width: ${WORKFLOW_DASHBOARD_SIDEBAR_WIDTH};
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: var(--grey-darker);
    position: relative;
  }

  .workflow-dashboard-shell .workflow-dashboard-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    width: var(--workflow-dashboard-sidebar-width);
    height: 100vh;
    background: var(--grey-darkest);
    border-right: 1px solid var(--grey);
    z-index: 250;
  }

  .workflow-dashboard-shell .workflow-dashboard-app {
    position: absolute;
    top: 0;
    left: var(--workflow-dashboard-sidebar-width);
    right: 0;
    bottom: 0;
    overflow: hidden;
    /* Creates a new containing block for all position:fixed children inside Rivet.
       This makes Rivet's fixed-position UI (LeftSidebar, ActionBar, StatusBar, etc.)
       position relative to this container instead of the viewport. */
    transform: translateX(0);
  }

  /* Ensure the .app div fills the positioned container (needed for NoProject height) */
  .workflow-dashboard-shell .workflow-dashboard-app > .app {
    height: 100%;
  }

  /* Override NodeCanvas viewport units — use viewport units adjusted for the sidebar
     width instead of percentages, because the intermediate elements (.app → GraphBuilder
     Container) have no explicit heights for percentage-based sizing to propagate. */
  .workflow-dashboard-shell .workflow-dashboard-app .node-canvas {
    width: calc(100vw - var(--workflow-dashboard-sidebar-width)) !important;
    height: 100vh !important;
  }
`;

export const WorkflowDashboardShell: FC<PropsWithChildren> = ({ children }) => {
  return (
    <div className="workflow-dashboard-shell">
      <style>{styles}</style>
      <div className="workflow-dashboard-app">{children}</div>
      <aside className="workflow-dashboard-sidebar">
        <WorkflowLibraryPanel />
      </aside>
    </div>
  );
};
