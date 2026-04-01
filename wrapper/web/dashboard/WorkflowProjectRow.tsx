import { type FC } from 'react';
import type { WorkflowProjectItem } from './types';
import type { DraggedWorkflowItem } from './workflowLibraryHelpers';

type WorkflowProjectRowProps = {
  project: WorkflowProjectItem;
  activePath: string;
  draggedItem: DraggedWorkflowItem | null;
  editorReady: boolean;
  setProjectRowRef: (path: string, node: HTMLButtonElement | null) => void;
  onDragStart: (item: DraggedWorkflowItem) => (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onContextMenu: (project: WorkflowProjectItem, event: React.MouseEvent<HTMLButtonElement>) => void;
  getParentRelativePath: (relativePath: string) => string;
};

export const WorkflowProjectRow: FC<WorkflowProjectRowProps> = ({
  project,
  activePath,
  draggedItem,
  editorReady,
  setProjectRowRef,
  onDragStart,
  onDragEnd,
  onSelect,
  onOpen,
  onContextMenu,
  getParentRelativePath,
}) => {
  return (
    <button
      key={project.id}
      ref={(node) => {
        setProjectRowRef(project.absolutePath, node);
      }}
      className={`project-row project-row-status-${project.settings.status}${activePath === project.absolutePath ? ' active' : ''}${draggedItem?.itemType === 'project' && draggedItem.absolutePath === project.absolutePath ? ' dragging' : ''}`}
      draggable={editorReady}
      disabled={!editorReady}
      onDragStart={onDragStart({
        itemType: 'project',
        absolutePath: project.absolutePath,
        relativePath: project.relativePath,
        parentRelativePath: getParentRelativePath(project.relativePath),
      })}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(project.absolutePath)}
      onDoubleClick={() => onOpen(project.absolutePath)}
      onContextMenu={(event) => onContextMenu(project, event)}
      title={editorReady ? project.fileName : 'Loading editor...'}
    >
      <div className="project-main">
        {project.settings.status !== 'unpublished' ? <span className={`project-status-dot ${project.settings.status}`} aria-hidden="true" /> : null}
        <div className="label">{project.name}</div>
      </div>
    </button>
  );
};
