import Button from '@atlaskit/button';
import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import ChevronDownIcon from 'majesticons/line/chevron-down-line.svg?react';
import ChevronRightIcon from 'majesticons/line/chevron-right-line.svg?react';
import CollapseLeftIcon from '../icons/arrow-collapse-left.svg?react';
import { toast } from 'react-toastify';
import { ActiveProjectSection } from './ActiveProjectSection';
import { ProjectSettingsModal } from './ProjectSettingsModal';
import { RuntimeLibrariesModal } from './RuntimeLibrariesModal';
import {
  createWorkflowFolder,
  createWorkflowProject,
  deleteWorkflowFolder,
  fetchWorkflowTree,
  moveWorkflowItem,
  renameWorkflowFolder,
} from './workflowApi';
import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
} from './types';
import './WorkflowLibraryPanel.css';

const normalizePath = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');

const ROOT_DROP_TARGET = '__root__';
const PROJECT_FILE_EXTENSION = '.rivet-project';

type DraggedWorkflowItem = {
  itemType: 'folder' | 'project';
  absolutePath: string;
  relativePath: string;
  parentRelativePath: string;
};

const flattenFolders = (items: WorkflowFolderItem[]): WorkflowFolderItem[] =>
  items.flatMap((folder) => [folder, ...flattenFolders(folder.folders ?? [])]);

const flattenProjects = (items: WorkflowFolderItem[]): WorkflowProjectItem[] =>
  items.flatMap((folder) => [...folder.projects, ...flattenProjects(folder.folders ?? [])]);

const collectFolderIds = (items: WorkflowFolderItem[]): string[] =>
  items.flatMap((folder) => [folder.id, ...collectFolderIds(folder.folders ?? [])]);

const getParentRelativePath = (relativePath: string) => {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const lastSlashIndex = normalized.lastIndexOf('/');
  return lastSlashIndex === -1 ? '' : normalized.slice(0, lastSlashIndex);
};

interface WorkflowLibraryPanelProps {
  onOpenProject: (path: string, options?: { replaceCurrent?: boolean }) => void;
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
  onSaveProject,
  onDeleteProject,
  onWorkflowPathsMoved,
  onActiveWorkflowProjectPathChange,
  openedProjectPath,
  editorReady,
  projectSaveSequence,
  onCollapse,
}) => {
  const [folders, setFolders] = useState<WorkflowFolderItem[]>([]);
  const [rootProjects, setRootProjects] = useState<WorkflowProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const projectRowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [draggedItem, setDraggedItem] = useState<DraggedWorkflowItem | null>(null);
  const [dropTargetFolderPath, setDropTargetFolderPath] = useState<string | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [selectedProjectPath, setSelectedProjectPath] = useState('');
  const [settingsModalProject, setSettingsModalProject] = useState<WorkflowProjectItem | null>(null);
  const [runtimeLibsOpen, setRuntimeLibsOpen] = useState(false);

  const refresh = useCallback(async (showLoading = true) => {
    if (showLoading) {
      setLoading(true);
    }
    setError(null);

    try {
      const tree = await fetchWorkflowTree();
      setFolders(tree.folders);
      setRootProjects(tree.projects);
      setExpandedFolders((prev) => {
        const next = { ...prev };
        for (const folderId of collectFolderIds(tree.folders)) {
          if (next[folderId] == null) {
            next[folderId] = false;
          }
        }
        return next;
      });
    } catch (err: any) {
      setError(err.message || 'Failed to load workflow folders');
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activePath = selectedProjectPath || openedProjectPath;

  const flattenedFolders = useMemo(() => flattenFolders(folders), [folders]);

  const folderIds = useMemo(() => flattenedFolders.map((folder) => folder.id), [flattenedFolders]);

  const allProjects = useMemo(() => [...rootProjects, ...flattenProjects(folders)], [folders, rootProjects]);

  const openedWorkflowProject = useMemo(
    () => allProjects.find((project) => project.absolutePath === openedProjectPath) ?? null,
    [allProjects, openedProjectPath],
  );
  const openedWorkflowProjectPath = openedWorkflowProject?.absolutePath ?? '';

  const activeProject = useMemo(
    () => allProjects.find((project) => project.absolutePath === activePath) ?? null,
    [activePath, allProjects],
  );

  const isActiveProjectOpen = activeProject != null && activeProject.absolutePath === openedProjectPath;

  useEffect(() => {
    if (!settingsModalOpen || !settingsModalProject) {
      return;
    }

    const matchingProject = allProjects.find((project) => project.absolutePath === settingsModalProject.absolutePath);
    if (matchingProject) {
      setSettingsModalProject(matchingProject);
    }
  }, [allProjects, settingsModalOpen, settingsModalProject]);

  useEffect(() => {
    if (!openedProjectPath) {
      return;
    }

    setSelectedProjectPath(openedProjectPath);
  }, [openedProjectPath]);

  useEffect(() => {
    if (!selectedProjectPath) {
      return;
    }

    if (allProjects.some((project) => project.absolutePath === selectedProjectPath)) {
      return;
    }

    setSelectedProjectPath(openedWorkflowProject?.absolutePath ?? '');
  }, [allProjects, openedWorkflowProject, selectedProjectPath]);

  useEffect(() => {
    onActiveWorkflowProjectPathChange(openedWorkflowProjectPath);
  }, [onActiveWorkflowProjectPathChange, openedWorkflowProjectPath]);

  useEffect(() => {
    if (projectSaveSequence === 0 || !openedWorkflowProjectPath) {
      return;
    }

    void refresh(false);
  }, [openedWorkflowProjectPath, projectSaveSequence, refresh]);

  const activeAncestorFolderIds = useMemo(() => {
    if (!activePath) {
      return [];
    }

    const normalizedActivePath = normalizePath(activePath);

    return flattenedFolders
      .filter((folder) => {
        const normalizedFolderPath = normalizePath(folder.absolutePath);
        return normalizedActivePath === normalizedFolderPath || normalizedActivePath.startsWith(`${normalizedFolderPath}/`);
      })
      .sort((left, right) => left.absolutePath.length - right.absolutePath.length)
      .map((folder) => folder.id);
  }, [activePath, flattenedFolders]);

  useEffect(() => {
    if (activeAncestorFolderIds.length === 0) {
      return;
    }

    setExpandedFolders((prev) => {
      let changed = false;
      const next = { ...prev };

      for (const folderId of activeAncestorFolderIds) {
        if (!next[folderId]) {
          next[folderId] = true;
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [activeAncestorFolderIds]);

  useEffect(() => {
    if (!activePath || loading) {
      return;
    }

    const activeRow = projectRowRefs.current[activePath];
    if (!activeRow) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      activeRow.scrollIntoView({ block: 'nearest' });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activePath, expandedFolders, loading]);

  const canDropIntoFolder = (item: DraggedWorkflowItem | null, destinationFolderRelativePath: string) => {
    if (!item) {
      return false;
    }

    if (item.parentRelativePath === destinationFolderRelativePath) {
      return false;
    }

    if (item.itemType === 'folder') {
      return !(
        item.relativePath === destinationFolderRelativePath ||
        destinationFolderRelativePath.startsWith(`${item.relativePath}/`)
      );
    }

    return true;
  };

  const resetDragState = () => {
    setDraggedItem(null);
    setDropTargetFolderPath(null);
    setDragOverRoot(false);
  };

  const toggleFolderExpanded = (folderId: string) => {
    setExpandedFolders((prev) => ({ ...prev, [folderId]: !(prev[folderId] ?? false) }));
  };

  const handleFolderRowClick = (folder: WorkflowFolderItem) => (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.folder-actions')) {
      return;
    }

    toggleFolderExpanded(folder.id);
  };

  const handleFolderRowKeyDown =
    (folder: WorkflowFolderItem) => (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.folder-actions')) {
        return;
      }

      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      toggleFolderExpanded(folder.id);
    };

  const handleMoveDraggedItem = async (destinationFolderRelativePath: string) => {
    if (!canDropIntoFolder(draggedItem, destinationFolderRelativePath) || !draggedItem) {
      return;
    }

    try {
      const result = await moveWorkflowItem(
        draggedItem.itemType,
        draggedItem.relativePath,
        destinationFolderRelativePath,
      );

      if (result.folder) {
        const movedFolder = result.folder;
        setExpandedFolders((prev) => ({ ...prev, [movedFolder.id]: true }));
      }

      if (result.movedProjectPaths.length > 0) {
        onWorkflowPathsMoved(result.movedProjectPaths);
      }

      await refresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to move workflow item');
    } finally {
      resetDragState();
    }
  };

  const handleDragStart = (item: DraggedWorkflowItem) => (event: React.DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.relativePath);
    setDraggedItem(item);
  };

  const handleDragEnd = () => {
    resetDragState();
  };

  const handleFolderDragOver = (folder: WorkflowFolderItem) => (event: React.DragEvent<HTMLElement>) => {
    if (!canDropIntoFolder(draggedItem, folder.relativePath)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetFolderPath(folder.relativePath);
    setDragOverRoot(false);
  };

  const handleFolderDrop = (folder: WorkflowFolderItem) => async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    await handleMoveDraggedItem(folder.relativePath);
  };

  const handleRootDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!canDropIntoFolder(draggedItem, '')) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetFolderPath(ROOT_DROP_TARGET);
    setDragOverRoot(true);
  };

  const handleRootDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    await handleMoveDraggedItem('');
  };

  const renderProjectRow = (project: WorkflowProjectItem) => (
    <button
      key={project.id}
      ref={(node) => {
        projectRowRefs.current[project.absolutePath] = node;
      }}
      className={`project-row project-row-status-${project.settings.status}${activePath === project.absolutePath ? ' active' : ''}${draggedItem?.itemType === 'project' && draggedItem.absolutePath === project.absolutePath ? ' dragging' : ''}`}
      draggable={editorReady}
      disabled={!editorReady}
      onDragStart={handleDragStart({
        itemType: 'project',
        absolutePath: project.absolutePath,
        relativePath: project.relativePath,
        parentRelativePath: getParentRelativePath(project.relativePath),
      })}
      onDragEnd={handleDragEnd}
      onClick={() => setSelectedProjectPath(project.absolutePath)}
      onDoubleClick={() => onOpenProject(project.absolutePath)}
      title={editorReady ? project.fileName : 'Loading editor...'}
    >
      <div className="project-main">
        {project.settings.status !== 'unpublished' ? <span className={`project-status-dot ${project.settings.status}`} aria-hidden="true" /> : null}
        <div className="label">{project.name}</div>
      </div>
    </button>
  );

  const handleCreateFolder = async () => {
    const name = prompt('New folder name:');
    if (!name) {
      return;
    }

    try {
      const folder = await createWorkflowFolder(name);
      setExpandedFolders((prev) => ({ ...prev, [folder.id]: true }));
      await refresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create folder');
    }
  };

  const handleRenameFolder = async (folder: WorkflowFolderItem) => {
    const newName = prompt('Rename folder:', folder.name);
    if (!newName || newName === folder.name) {
      return;
    }

    try {
      await renameWorkflowFolder(folder.relativePath, newName);
      await refresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to rename folder');
    }
  };

  const handleAddProject = async (folder: WorkflowFolderItem) => {
    const name = prompt(`New Rivet project name in folder "${folder.name}":`);
    if (!name) {
      return;
    }

    try {
      const project = await createWorkflowProject(folder.relativePath, name);
      setExpandedFolders((prev) => ({ ...prev, [folder.id]: true }));
      await refresh();
      onOpenProject(project.absolutePath);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create project');
    }
  };

  const handleDeleteFolder = async (folder: WorkflowFolderItem) => {
    const shouldDelete = window.confirm(`Delete empty folder "${folder.name}"?`);
    if (!shouldDelete) {
      return;
    }

    try {
      await deleteWorkflowFolder(folder.relativePath);
      await refresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete folder');
    }
  };

  const handleOpenSettings = () => {
    if (!activeProject) {
      return;
    }

    setSettingsModalProject(activeProject);
    setSettingsModalOpen(true);
  };

  const handleWorkflowProjectPathsMoved = (moves: WorkflowProjectPathMove[]) => {
    if (moves.length === 0) {
      return;
    }

    setSelectedProjectPath((prev) => moves.find((move) => move.fromAbsolutePath === prev)?.toAbsolutePath ?? prev);
    setSettingsModalProject((prev) => {
      if (!prev) {
        return prev;
      }

      const nextPath = moves.find((move) => move.fromAbsolutePath === prev.absolutePath)?.toAbsolutePath;
      return nextPath ? { ...prev, absolutePath: nextPath } : prev;
    });
    onWorkflowPathsMoved(moves);
  };

  const closeSettingsModal = () => {
    setSettingsModalOpen(false);
    setSettingsModalProject(null);
  };

  const renderFolder = (folder: WorkflowFolderItem): JSX.Element => {
    const expanded = expandedFolders[folder.id] ?? false;

    return (
      <div className="folder" key={folder.id}>
        <div
          className={`folder-row${dropTargetFolderPath === folder.relativePath ? ' drag-over' : ''}${draggedItem?.itemType === 'folder' && draggedItem.absolutePath === folder.absolutePath ? ' dragging' : ''}`}
          draggable={editorReady}
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${folder.name}`}
          onClick={handleFolderRowClick(folder)}
          onKeyDown={handleFolderRowKeyDown(folder)}
          onDragStart={handleDragStart({
            itemType: 'folder',
            absolutePath: folder.absolutePath,
            relativePath: folder.relativePath,
            parentRelativePath: getParentRelativePath(folder.relativePath),
          })}
          onDragEnd={handleDragEnd}
          onDragOver={handleFolderDragOver(folder)}
          onDragLeave={() => {
            if (dropTargetFolderPath === folder.relativePath) {
              setDropTargetFolderPath(null);
            }
          }}
          onDrop={(event) => void handleFolderDrop(folder)(event)}
        >
          <span className="folder-toggle" aria-hidden="true">
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
          <div className="folder-content">
            <button
              type="button"
              className="folder-name-button"
              onDoubleClick={(event) => {
                event.stopPropagation();
                void handleRenameFolder(folder);
              }}
              title={folder.name}
            >
              <div className="folder-main">
                <div className="label">{folder.name}</div>
              </div>
            </button>
          </div>
          <div className="folder-actions">
            <button
              type="button"
              className="icon-button"
              onClick={(event) => {
                event.stopPropagation();
                void handleAddProject(folder);
              }}
              title={`Create project in ${folder.name}`}
              aria-label={`Create project in ${folder.name}`}
            >
              +
            </button>
          </div>
        </div>

        {expanded ? (
          <div className="projects">
            {(folder.folders ?? []).map((childFolder) => renderFolder(childFolder))}
            {(folder.folders ?? []).length === 0 && folder.projects.length === 0 ? (
              <div className="state folder-empty-state">
                <span>No Rivet projects in this folder.</span>
                <button type="button" className="state-action" onClick={() => void handleDeleteFolder(folder)}>
                  Delete
                </button>
              </div>
            ) : null}
            {folder.projects.map((project) => renderProjectRow(project))}
          </div>
        ) : null}
      </div>
    );
  };

  let bodyContent: JSX.Element | null = null;
  if (loading) {
    bodyContent = <div className="state">Loading folders...</div>;
  } else if (error) {
    bodyContent = <div className="state">{error}</div>;
  } else if (folderIds.length === 0 && rootProjects.length === 0) {
    bodyContent = <div className="state">No workflow projects yet. Use + New folder to create the first folder.</div>;
  } else {
    bodyContent = (
      <>
        {rootProjects.length > 0 ? <div className="projects">{rootProjects.map((project) => renderProjectRow(project))}</div> : null}
        {folders.map((folder) => renderFolder(folder))}
      </>
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
        onDragLeave={() => {
          setDragOverRoot(false);
          if (dropTargetFolderPath === ROOT_DROP_TARGET) {
            setDropTargetFolderPath(null);
          }
        }}
        onDrop={(event) => void handleRootDrop(event)}
      >
        {!editorReady ? <div className="body-status body-status-top">Loading editor...</div> : null}
        {bodyContent}
        <div className="body-actions">
          <Button appearance="subtle-link" spacing="compact" className="link-button button-size-m" onClick={() => void handleCreateFolder()}>
            + New folder
          </Button>
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
      </div>

      {settingsModalOpen && settingsModalProject ? (
        <ProjectSettingsModal
          activeProject={settingsModalProject}
          allProjects={allProjects}
          isOpen={settingsModalOpen}
          onClose={closeSettingsModal}
          onRefresh={() => refresh(false)}
          onDeleteProject={onDeleteProject}
          onWorkflowPathsMoved={handleWorkflowProjectPathsMoved}
        />
      ) : null}

      <RuntimeLibrariesModal
        isOpen={runtimeLibsOpen}
        onClose={() => setRuntimeLibsOpen(false)}
      />
    </div>
  );
};
