import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FC } from 'react';
import FolderIcon from 'majesticons/line/folder-line.svg?react';
import FileIcon from 'majesticons/line/file-line.svg?react';
import ChevronDownIcon from 'majesticons/line/chevron-down-line.svg?react';
import ChevronRightIcon from 'majesticons/line/chevron-right-line.svg?react';
import ExpandLeftIcon from 'majesticons/line/menu-expand-left-line.svg?react';
import { toast } from 'react-toastify';
import {
  createWorkflowFolder,
  createWorkflowProject,
  deleteWorkflowProject,
  fetchWorkflowTree,
  moveWorkflowItem,
  publishWorkflowProject,
  renameWorkflowFolder,
  unpublishWorkflowProject,
} from './workflowApi';
import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
} from './types';
import './WorkflowLibraryPanel.css';

const normalizePath = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');

const ROOT_DROP_TARGET = '__root__';

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

const STATUS_LABELS: Record<WorkflowProjectStatus, string> = {
  unpublished: 'Unpublished',
  published: 'Published',
  unpublished_changes: 'Unpublished changes',
};

const ENDPOINT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface WorkflowLibraryPanelProps {
  onOpenProject: (path: string, options?: { replaceCurrent?: boolean }) => void;
  onSaveProject: () => void;
  onDeleteProject: (path: string) => void;
  onWorkflowPathsMoved: (moves: WorkflowProjectPathMove[]) => void;
  activeProjectPath: string;
  editorReady: boolean;
  projectSaveSequence: number;
  onCollapse?: () => void;
}

export const WorkflowLibraryPanel: FC<WorkflowLibraryPanelProps> = ({
  onOpenProject,
  onSaveProject,
  onDeleteProject,
  onWorkflowPathsMoved,
  activeProjectPath,
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
  const [settingsDraft, setSettingsDraft] = useState<WorkflowProjectSettingsDraft>({
    endpointName: '',
  });
  const [savingSettings, setSavingSettings] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

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
            next[folderId] = true;
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

  const activePath = activeProjectPath;

  const flattenedFolders = useMemo(() => flattenFolders(folders), [folders]);

  const folderIds = useMemo(() => flattenedFolders.map((folder) => folder.id), [flattenedFolders]);

  const allProjects = useMemo(() => [...rootProjects, ...flattenProjects(folders)], [folders, rootProjects]);

  const activeProject = useMemo(
    () => allProjects.find((project) => project.absolutePath === activePath) ?? null,
    [activePath, allProjects],
  );

  const normalizedDraftEndpointName = useMemo(
    () => settingsDraft.endpointName.trim().toLowerCase(),
    [settingsDraft.endpointName],
  );

  const endpointDuplicateProject = useMemo(() => {
    if (!activeProject || !normalizedDraftEndpointName) {
      return null;
    }

    return allProjects.find(
      (project) =>
        project.absolutePath !== activeProject.absolutePath &&
        project.settings.endpointName === normalizedDraftEndpointName,
    ) ?? null;
  }, [activeProject, allProjects, normalizedDraftEndpointName]);

  const endpointValidationError = useMemo(() => {
    if (!normalizedDraftEndpointName) {
      return 'Endpoint name is required to publish.';
    }

    if (!ENDPOINT_NAME_PATTERN.test(normalizedDraftEndpointName)) {
      return 'Endpoint name must contain only lowercase letters, numbers, and hyphens.';
    }

    if (endpointDuplicateProject) {
      return `Endpoint name is already used by ${endpointDuplicateProject.fileName}.`;
    }

    return null;
  }, [endpointDuplicateProject, normalizedDraftEndpointName]);

  const displayedProjectStatus: WorkflowProjectStatus = activeProject?.settings.status ?? 'unpublished';

  const primarySettingsActionLabel =
    displayedProjectStatus === 'published'
      ? 'Unpublish'
      : displayedProjectStatus === 'unpublished_changes'
        ? 'Publish changes'
        : 'Publish';

  const disablePrimarySettingsAction =
    savingSettings ||
    deletingProject ||
    (displayedProjectStatus !== 'published' && endpointValidationError != null);

  useEffect(() => {
    if (!activeProject) {
      setSettingsModalOpen(false);
      return;
    }

    setSettingsDraft({ endpointName: activeProject.settings.endpointName });
  }, [activeProject]);

  useEffect(() => {
    if (projectSaveSequence === 0 || !activeProjectPath) {
      return;
    }

    void refresh(false);
  }, [activeProjectPath, projectSaveSequence, refresh]);

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
      className={`project-row${activePath === project.absolutePath ? ' active' : ''}${draggedItem?.itemType === 'project' && draggedItem.absolutePath === project.absolutePath ? ' dragging' : ''}`}
      draggable={editorReady}
      disabled={!editorReady}
      onDragStart={handleDragStart({
        itemType: 'project',
        absolutePath: project.absolutePath,
        relativePath: project.relativePath,
        parentRelativePath: getParentRelativePath(project.relativePath),
      })}
      onDragEnd={handleDragEnd}
      onClick={() => onOpenProject(project.absolutePath)}
      onDoubleClick={() => onOpenProject(project.absolutePath, { replaceCurrent: true })}
      title={editorReady ? project.fileName : 'Loading editor...'}
    >
      <div className="project-main">
        <FileIcon />
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

  const handleSettingsDraftChange =
    <K extends keyof WorkflowProjectSettingsDraft>(key: K) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value as WorkflowProjectSettingsDraft[K];
      setSettingsDraft((prev) => ({
        ...prev,
        [key]: value,
      }));
    };

  const handleOpenSettings = () => {
    if (!activeProject) {
      return;
    }

    setSettingsDraft({ endpointName: activeProject.settings.endpointName });
    setSettingsModalOpen(true);
  };

  const handlePrimarySettingsAction = async () => {
    if (!activeProject) {
      return;
    }

    if (displayedProjectStatus === 'published') {
      const shouldUnpublish = window.confirm(`Unpublish project "${activeProject.fileName}"?`);
      if (!shouldUnpublish) {
        return;
      }
    }

    setSavingSettings(true);

    try {
      if (displayedProjectStatus === 'published') {
        await unpublishWorkflowProject(activeProject.relativePath);
      } else {
        await publishWorkflowProject(activeProject.relativePath, {
          endpointName: settingsDraft.endpointName,
        });
      }
      await refresh(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update project publication state');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleDeleteActiveProject = async () => {
    if (!activeProject) {
      return;
    }

    const shouldDelete = window.confirm(`Delete project "${activeProject.name}"? This cannot be undone.`);
    if (!shouldDelete) {
      return;
    }

    setDeletingProject(true);

    try {
      if (displayedProjectStatus !== 'unpublished') {
        await unpublishWorkflowProject(activeProject.relativePath);
      }
      await deleteWorkflowProject(activeProject.relativePath);
      onDeleteProject(activeProject.absolutePath);
      setSettingsModalOpen(false);
      await refresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete project');
    } finally {
      setDeletingProject(false);
    }
  };

  const renderFolder = (folder: WorkflowFolderItem): JSX.Element => {
    const expanded = expandedFolders[folder.id] ?? true;

    return (
      <div className="folder" key={folder.id}>
        <div
          className={`folder-row${dropTargetFolderPath === folder.relativePath ? ' drag-over' : ''}${draggedItem?.itemType === 'folder' && draggedItem.absolutePath === folder.absolutePath ? ' dragging' : ''}`}
          draggable={editorReady}
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
          <button
            type="button"
            className="folder-toggle"
            onClick={() => setExpandedFolders((prev) => ({ ...prev, [folder.id]: !expanded }))}
            title={folder.name}
            aria-label={expanded ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
          >
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </button>
          <div className="folder-content">
            <button
              type="button"
              className="folder-name-button"
              onDoubleClick={() => void handleRenameFolder(folder)}
              title={folder.name}
            >
              <div className="folder-main">
                <FolderIcon />
                <div className="label">{folder.name}</div>
              </div>
            </button>
          </div>
          <div className="folder-actions">
            <button
              type="button"
              className="icon-button"
              onClick={() => void handleAddProject(folder)}
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
            {(folder.folders ?? []).length === 0 && folder.projects.length === 0 ? <div className="state">No Rivet projects in this folder.</div> : null}
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
        <div className="header-title">Projects</div>
        <div className="header-actions">
          {onCollapse ? (
            <button
              type="button"
              className="icon-button"
              onClick={onCollapse}
              title="Collapse folders pane"
              aria-label="Collapse folders pane"
            >
              <ExpandLeftIcon />
            </button>
          ) : null}
        </div>
      </div>

      {activeProject ? (
        <div className="active-project-section">
          <div className="active-project-section-content">
            <div className="active-project-details">
              <div className="active-project-label">Active project</div>
              <div className="active-project-name" title={activeProject.fileName}>
                {activeProject.fileName}
              </div>
              <div className="active-project-status-row">
                <span className={`project-status-badge ${activeProject.settings.status}`}>
                  {STATUS_LABELS[activeProject.settings.status]}
                </span>
              </div>
            </div>

            <div className="active-project-actions">
              <button
                type="button"
                className="active-project-save-button"
                disabled={!editorReady}
                onClick={onSaveProject}
                title={editorReady ? 'Save current project' : 'Loading editor...'}
                aria-label={editorReady ? 'Save current project' : 'Loading editor'}
              >
                Save
              </button>
              <button type="button" className="active-project-more-button" onClick={handleOpenSettings}>
                More
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
        <div className="body-actions">
          <button type="button" className="link-button" onClick={() => void handleCreateFolder()}>
            + New folder
          </button>
          {!editorReady ? <div className="body-status">Loading editor...</div> : null}
        </div>
        {bodyContent}
      </div>

      {settingsModalOpen && activeProject ? (
        <div className="project-settings-modal-backdrop" onClick={() => !savingSettings && !deletingProject && setSettingsModalOpen(false)}>
          <div className="project-settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="project-settings-modal-header">
              <div className="project-settings-modal-heading">
                <div className="project-settings-modal-title" title={activeProject.fileName}>{activeProject.fileName}</div>
                <div className="active-project-status-row">
                  <span className={`project-status-badge ${displayedProjectStatus}`}>
                    {STATUS_LABELS[displayedProjectStatus]}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setSettingsModalOpen(false)}
                disabled={savingSettings || deletingProject}
                aria-label="Close project settings"
              >
                ×
              </button>
            </div>

            <div className="project-settings-field">
              <label className="project-settings-label" htmlFor="workflow-project-endpoint-name">
                Endpoint name
              </label>
              <input
                id="workflow-project-endpoint-name"
                className="project-settings-input"
                type="text"
                value={settingsDraft.endpointName}
                onChange={handleSettingsDraftChange('endpointName')}
                disabled={savingSettings || deletingProject || displayedProjectStatus !== 'unpublished'}
                spellCheck={false}
              />
              <div className="project-settings-help">Must be URL-compatible so `host/workflows/[endpoint name]` is a valid path.</div>
              {displayedProjectStatus !== 'unpublished' ? (
                <div className="project-settings-help">Unpublish the project to change its endpoint.</div>
              ) : null}
              {endpointValidationError ? <div className="project-settings-error">{endpointValidationError}</div> : null}
            </div>

            <div className="project-settings-actions">
              <button
                type="button"
                className="project-settings-delete-button"
                onClick={() => void handleDeleteActiveProject()}
                disabled={savingSettings || deletingProject}
              >
                {deletingProject ? 'Deleting...' : 'Delete project'}
              </button>
              <div className="project-settings-action-group">
                <button
                  type="button"
                  className={`project-settings-primary-button${displayedProjectStatus === 'published' ? ' unpublish' : ''}`}
                  onClick={() => void handlePrimarySettingsAction()}
                  disabled={disablePrimarySettingsAction}
                >
                  {savingSettings ? 'Working...' : primarySettingsActionLabel}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
