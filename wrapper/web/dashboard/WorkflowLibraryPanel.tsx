import Button from '@atlaskit/button';
import type { FC } from 'react';
import CollapseLeftIcon from '../icons/arrow-collapse-left.svg?react';
import { ActiveProjectSection } from './ActiveProjectSection';
import { WorkflowFolderTree } from './WorkflowFolderTree';
import { WorkflowLibraryContextMenus } from './WorkflowLibraryContextMenus';
import { WorkflowLibraryModals } from './WorkflowLibraryModals';
import type { WorkflowProjectPathMove } from './types';
import { getParentRelativePath } from './workflowLibraryHelpers';
import { useWorkflowLibraryController } from './useWorkflowLibraryController';
import './WorkflowLibraryPanel.css';

interface WorkflowLibraryPanelProps {
  onOpenProject: (path: string, options?: { replaceCurrent?: boolean }) => void;
  onOpenRecording: (recordingId: string, options?: { replaceCurrent?: boolean }) => void;
  onSaveProject: () => void;
  onDeleteProject: (path: string) => void;
  onWorkflowPathsMoved: (moves: WorkflowProjectPathMove[]) => void;
  onActiveWorkflowProjectPathChange: (path: string) => void;
  openedProjectPath: string;
  editorReady: boolean;
  projectSaveSequence: number;
  onCollapse?: () => void;
}

export const WorkflowLibraryPanel: FC<WorkflowLibraryPanelProps> = ({
  onOpenProject,
  onOpenRecording,
  onSaveProject,
  onDeleteProject,
  onWorkflowPathsMoved,
  onActiveWorkflowProjectPathChange,
  openedProjectPath,
  editorReady,
  projectSaveSequence,
  onCollapse,
}) => {
  const controller = useWorkflowLibraryController({
    onOpenProject,
    onOpenRecording,
    onDeleteProject,
    onWorkflowPathsMoved,
    onActiveWorkflowProjectPathChange,
    openedProjectPath,
    projectSaveSequence,
  });

  const {
    folders,
    rootProjects,
    folderIds,
    activePath,
    activeProject,
    loading,
    error,
    expandedFolders,
    draggedItem,
    dropTargetFolderPath,
    dragOverRoot,
    isActiveProjectOpen,
    handleCreateFolder,
    handleOpenSettings,
    handleProjectContextMenu,
    handleFolderContextMenu,
    handleDragStart,
    handleDragEnd,
    handleFolderRowClick,
    handleFolderRowKeyDown,
    handleFolderDragOver,
    handleFolderDrop,
    handleFolderDragLeave,
    handleRootDragOver,
    handleRootDragLeave,
    handleRootDrop,
    onProjectSelect,
    onProjectOpen,
    setProjectRowRef,
    setRuntimeLibsOpen,
    setRunRecordingsOpen,
  } = controller;

  let bodyContent: JSX.Element | null = null;
  if (loading) {
    bodyContent = <div className="state">Loading folders...</div>;
  } else if (error) {
    bodyContent = <div className="state">{error}</div>;
  } else if (folderIds.length === 0 && rootProjects.length === 0) {
    bodyContent = <div className="state">No workflow projects yet. Use + New folder to create the first folder.</div>;
  } else {
    bodyContent = (
      <WorkflowFolderTree
        folders={folders}
        rootProjects={rootProjects}
        activePath={activePath}
        draggedItem={draggedItem}
        dropTargetFolderPath={dropTargetFolderPath}
        expandedFolders={expandedFolders}
        editorReady={editorReady}
        setProjectRowRef={setProjectRowRef}
        onProjectSelect={onProjectSelect}
        onProjectOpen={onProjectOpen}
        onProjectContextMenu={handleProjectContextMenu}
        onFolderContextMenu={handleFolderContextMenu}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onFolderClick={handleFolderRowClick}
        onFolderKeyDown={handleFolderRowKeyDown}
        onFolderDragOver={handleFolderDragOver}
        onFolderDrop={(folder) => (event) => void handleFolderDrop(folder)(event)}
        onFolderDragLeave={handleFolderDragLeave}
        getParentRelativePath={getParentRelativePath}
      />
    );
  }

  return (
    <div className="workflow-library-panel">
      <div className="header">
        <div className="header-title">Rivet Projects</div>
        <div className="header-actions">
          {onCollapse ? (
            <Button
              appearance="subtle"
              spacing="compact"
              className="collapse-button button-size-s"
              onClick={onCollapse}
              title="Collapse folders pane"
              aria-label="Collapse folders pane"
            >
              <CollapseLeftIcon />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="active-project-slot">
        <ActiveProjectSection
          activeProject={activeProject}
          isCurrentlyOpen={isActiveProjectOpen}
          editorReady={editorReady}
          onSave={onSaveProject}
          onOpen={onOpenProject}
          onOpenSettings={handleOpenSettings}
        />
      </div>

      <div
        className={`body${dragOverRoot ? ' drag-over-root' : ''}`}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={(event) => void handleRootDrop(event)}
      >
        {!editorReady ? <div className="body-status body-status-top">Loading editor...</div> : null}
        {bodyContent}
        <div className="body-actions">
          <button type="button" className="link-button" onClick={() => void handleCreateFolder()}>
            + New folder
          </button>
        </div>
      </div>

      <div className="panel-bottom-actions">
        <Button
          appearance="subtle"
          className="panel-bottom-button project-settings-secondary-button button-size-m"
          onClick={() => setRuntimeLibsOpen(true)}
          title="Manage runtime libraries available to Code nodes"
        >
          Runtime libraries
        </Button>
        <Button
          appearance="subtle"
          className="panel-bottom-button project-settings-secondary-button button-size-m"
          onClick={() => setRunRecordingsOpen(true)}
          title="Browse workflow run recordings and load them into the editor"
        >
          Run recordings
        </Button>
      </div>

      <WorkflowLibraryContextMenus controller={controller} />
      <WorkflowLibraryModals controller={controller} />
    </div>
  );
};
