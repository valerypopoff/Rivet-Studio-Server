import { type FC } from 'react';
import ChevronDownIcon from 'majesticons/line/chevron-down-line.svg?react';
import ChevronRightIcon from 'majesticons/line/chevron-right-line.svg?react';
import type { WorkflowFolderItem, WorkflowProjectItem } from './types';
import type { DraggedWorkflowItem } from './workflowLibraryHelpers';
import { countProjectsInFolder } from './workflowLibraryHelpers';
import { WorkflowProjectRow } from './WorkflowProjectRow';

type WorkflowFolderTreeProps = {
  folders: WorkflowFolderItem[];
  rootProjects: WorkflowProjectItem[];
  activePath: string;
  draggedItem: DraggedWorkflowItem | null;
  dropTargetFolderPath: string | null;
  expandedFolders: Record<string, boolean>;
  editorReady: boolean;
  setProjectRowRef: (path: string, node: HTMLButtonElement | null) => void;
  onProjectSelect: (path: string) => void;
  onProjectOpen: (path: string) => void;
  onProjectContextMenu: (project: WorkflowProjectItem, event: React.MouseEvent<HTMLButtonElement>) => void;
  onFolderContextMenu: (folder: WorkflowFolderItem, event: React.MouseEvent<HTMLDivElement>) => void;
  onDragStart: (item: DraggedWorkflowItem) => (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onFolderClick: (folder: WorkflowFolderItem) => (event: React.MouseEvent<HTMLElement>) => void;
  onFolderKeyDown: (folder: WorkflowFolderItem) => (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onFolderDragOver: (folder: WorkflowFolderItem) => (event: React.DragEvent<HTMLElement>) => void;
  onFolderDrop: (folder: WorkflowFolderItem) => (event: React.DragEvent<HTMLElement>) => void;
  onFolderDragLeave: (folder: WorkflowFolderItem) => void;
  getParentRelativePath: (relativePath: string) => string;
};

export const WorkflowFolderTree: FC<WorkflowFolderTreeProps> = ({
  folders,
  rootProjects,
  activePath,
  draggedItem,
  dropTargetFolderPath,
  expandedFolders,
  editorReady,
  setProjectRowRef,
  onProjectSelect,
  onProjectOpen,
  onProjectContextMenu,
  onFolderContextMenu,
  onDragStart,
  onDragEnd,
  onFolderClick,
  onFolderKeyDown,
  onFolderDragOver,
  onFolderDrop,
  onFolderDragLeave,
  getParentRelativePath,
}) => {
  const renderProjectRow = (project: WorkflowProjectItem) => (
    <WorkflowProjectRow
      key={project.id}
      project={project}
      activePath={activePath}
      draggedItem={draggedItem}
      editorReady={editorReady}
      setProjectRowRef={setProjectRowRef}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onSelect={onProjectSelect}
      onOpen={onProjectOpen}
      onContextMenu={onProjectContextMenu}
      getParentRelativePath={getParentRelativePath}
    />
  );

  const renderFolder = (folder: WorkflowFolderItem): JSX.Element => {
    const expanded = expandedFolders[folder.id] ?? false;
    const projectCount = countProjectsInFolder(folder);

    return (
      <div className="folder" key={folder.id}>
        <div
          className={`folder-row${dropTargetFolderPath === folder.relativePath ? ' drag-over' : ''}${draggedItem?.itemType === 'folder' && draggedItem.absolutePath === folder.absolutePath ? ' dragging' : ''}`}
          draggable={editorReady}
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${folder.name}`}
          onClick={onFolderClick(folder)}
          onKeyDown={onFolderKeyDown(folder)}
          onContextMenu={(event) => onFolderContextMenu(folder, event)}
          onDragStart={onDragStart({
            itemType: 'folder',
            absolutePath: folder.absolutePath,
            relativePath: folder.relativePath,
            parentRelativePath: getParentRelativePath(folder.relativePath),
          })}
          onDragEnd={onDragEnd}
          onDragOver={onFolderDragOver(folder)}
          onDragLeave={() => onFolderDragLeave(folder)}
          onDrop={onFolderDrop(folder)}
        >
          <span className="folder-toggle" aria-hidden="true">
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
          <div className="folder-content">
            <div className="folder-name-button" title={folder.name}>
              <div className="folder-main">
                <div className="label">{folder.name}</div>
                <div className="folder-project-count" aria-label={`${projectCount} project${projectCount === 1 ? '' : 's'} in ${folder.name}`}>
                  {projectCount}
                </div>
              </div>
            </div>
          </div>
        </div>

        {expanded ? (
          <div className="folder-children">
            {(folder.folders ?? []).map((childFolder) => renderFolder(childFolder))}
            {(folder.folders ?? []).length === 0 && folder.projects.length === 0 ? (
              <div className="state folder-empty-state">
                <span>No Rivet projects in this folder.</span>
              </div>
            ) : null}
            {folder.projects.map((project) => renderProjectRow(project))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      {rootProjects.length > 0 ? <div className="projects">{rootProjects.map((project) => renderProjectRow(project))}</div> : null}
      {folders.map((folder) => renderFolder(folder))}
    </>
  );
};
