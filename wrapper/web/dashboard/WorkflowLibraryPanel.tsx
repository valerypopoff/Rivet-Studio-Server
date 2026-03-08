import Button, { LoadingButton } from '@atlaskit/button';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import TextField from '@atlaskit/textfield';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FC, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import FolderIcon from 'majesticons/line/folder-line.svg?react';
import FileIcon from 'majesticons/line/file-line.svg?react';
import ChevronDownIcon from 'majesticons/line/chevron-down-line.svg?react';
import ChevronRightIcon from 'majesticons/line/chevron-right-line.svg?react';
import ExpandLeftIcon from 'majesticons/line/menu-expand-left-line.svg?react';
import { toast } from 'react-toastify';
import {
  createWorkflowFolder,
  createWorkflowProject,
  deleteWorkflowFolder,
  deleteWorkflowProject,
  fetchWorkflowTree,
  moveWorkflowItem,
  publishWorkflowProject,
  renameWorkflowProject,
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

const STATUS_LABELS: Record<WorkflowProjectStatus, string> = {
  unpublished: 'Unpublished',
  published: 'Published',
  unpublished_changes: 'Unpublished changes',
};

const ENDPOINT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface WorkflowLibraryPanelProps {
  onOpenProject: (path: string, options?: { replaceCurrent?: boolean }) => void;
  onSelectProject: (path: string) => void;
  onSaveProject: () => void;
  onDeleteProject: (path: string) => void;
  onWorkflowPathsMoved: (moves: WorkflowProjectPathMove[]) => void;
  selectedProjectPath: string;
  openedProjectPath: string;
  editorReady: boolean;
  projectSaveSequence: number;
  onCollapse?: () => void;
}

export const WorkflowLibraryPanel: FC<WorkflowLibraryPanelProps> = ({
  onOpenProject,
  onSelectProject,
  onSaveProject,
  onDeleteProject,
  onWorkflowPathsMoved,
  selectedProjectPath,
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
  const [settingsDraft, setSettingsDraft] = useState<WorkflowProjectSettingsDraft>({
    endpointName: '',
  });
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [renamingProject, setRenamingProject] = useState(false);
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

  const activePath = selectedProjectPath;

  const flattenedFolders = useMemo(() => flattenFolders(folders), [folders]);

  const folderIds = useMemo(() => flattenedFolders.map((folder) => folder.id), [flattenedFolders]);

  const allProjects = useMemo(() => [...rootProjects, ...flattenProjects(folders)], [folders, rootProjects]);

  const activeProject = useMemo(
    () => allProjects.find((project) => project.absolutePath === activePath) ?? null,
    [activePath, allProjects],
  );

  const isActiveProjectOpen = activeProject != null && activeProject.absolutePath === openedProjectPath;

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

  const normalizedProjectNameDraft = useMemo(() => {
    const trimmed = projectNameDraft.trim();
    return trimmed.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)
      ? trimmed.slice(0, -PROJECT_FILE_EXTENSION.length).trim()
      : trimmed;
  }, [projectNameDraft]);

  const duplicateProjectNameInFolder = useMemo(() => {
    if (!activeProject || !normalizedProjectNameDraft) {
      return null;
    }

    const activeParentRelativePath = getParentRelativePath(activeProject.relativePath);

    return allProjects.find((project) => {
      if (project.absolutePath === activeProject.absolutePath) {
        return false;
      }

      return getParentRelativePath(project.relativePath) === activeParentRelativePath && project.name.toLowerCase() === normalizedProjectNameDraft.toLowerCase();
    }) ?? null;
  }, [activeProject, allProjects, normalizedProjectNameDraft]);

  const projectNameValidationError = useMemo(() => {
    if (!editingProjectName) {
      return null;
    }

    if (!normalizedProjectNameDraft) {
      return 'Project name is required.';
    }

    if (/[\\/]/.test(normalizedProjectNameDraft)) {
      return 'Project name must not contain path separators.';
    }

    if (/[<>:"|?*]/.test(normalizedProjectNameDraft)) {
      return 'Project name contains invalid filesystem characters.';
    }

    if (duplicateProjectNameInFolder) {
      return `A project named ${duplicateProjectNameInFolder.fileName} already exists in this folder.`;
    }

    return null;
  }, [duplicateProjectNameInFolder, editingProjectName, normalizedProjectNameDraft]);

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

  const showSecondaryUnpublishAction = displayedProjectStatus === 'unpublished_changes';

  const disablePrimarySettingsAction =
    savingSettings ||
    deletingProject ||
    (displayedProjectStatus !== 'published' && endpointValidationError != null);

  const disableSecondaryUnpublishAction = savingSettings || deletingProject;
  const disableDeleteProjectAction = savingSettings || deletingProject || displayedProjectStatus !== 'unpublished';

  useEffect(() => {
    if (!activeProject) {
      setSettingsModalOpen(false);
      setEditingProjectName(false);
      return;
    }

    setSettingsDraft({ endpointName: activeProject.settings.endpointName });
    setProjectNameDraft(activeProject.name);
    setEditingProjectName(false);
  }, [activeProject]);

  useEffect(() => {
    if (projectSaveSequence === 0 || !openedProjectPath) {
      return;
    }

    void refresh(false);
  }, [openedProjectPath, projectSaveSequence, refresh]);

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

  const handleProjectNameDraftChange = (event: ChangeEvent<HTMLInputElement>) => {
    setProjectNameDraft(event.target.value);
  };

  const handleStartProjectRename = () => {
    if (!activeProject || savingSettings || deletingProject || renamingProject) {
      return;
    }

    setProjectNameDraft(activeProject.name);
    setEditingProjectName(true);
  };

  const handleCommitProjectRename = async () => {
    if (!activeProject) {
      return;
    }

    const normalizedName = normalizedProjectNameDraft;
    if (!normalizedName) {
      return;
    }

    if (projectNameValidationError) {
      return;
    }

    if (normalizedName === activeProject.name) {
      setEditingProjectName(false);
      setProjectNameDraft(activeProject.name);
      return;
    }

    setRenamingProject(true);

    try {
      const result = await renameWorkflowProject(activeProject.relativePath, normalizedName);
      if (result.movedProjectPaths.length > 0) {
        onWorkflowPathsMoved(result.movedProjectPaths);
      }
      await refresh(false);
      setEditingProjectName(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to rename project');
    } finally {
      setRenamingProject(false);
    }
  };

  const handleProjectNameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleCommitProjectRename();
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
      onClick={() => onSelectProject(project.absolutePath)}
      onDoubleClick={() => onOpenProject(project.absolutePath)}
      title={editorReady ? project.fileName : 'Loading editor...'}
    >
      <div className="project-main">
        {project.settings.status === 'unpublished' ? <FileIcon /> : <span className={`project-status-dot ${project.settings.status}`} aria-hidden="true" />}
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
    setProjectNameDraft(activeProject.name);
    setEditingProjectName(false);
    setSettingsModalOpen(true);
  };

  const closeSettingsModal = () => {
    if (!savingSettings && !deletingProject) {
      setSettingsModalOpen(false);
    }
  };

  const handleCopyEndpointName = async () => {
    const endpointName = settingsDraft.endpointName.trim();
    if (!endpointName) {
      return;
    }

    try {
      await navigator.clipboard.writeText(endpointName);
      toast.success('Endpoint copied', {
        toastId: 'workflow-endpoint-copy-success',
        className: 'dashboard-toast dashboard-toast-success',
        bodyClassName: 'dashboard-toast-body',
        position: 'bottom-center',
      });
    } catch {
      toast.error('Could not copy endpoint', {
        toastId: 'workflow-endpoint-copy-error',
        className: 'dashboard-toast dashboard-toast-error',
        bodyClassName: 'dashboard-toast-body',
        position: 'bottom-center',
      });
    }
  };

  const handlePrimarySettingsAction = async (action: 'primary' | 'unpublish' = 'primary') => {
    if (!activeProject) {
      return;
    }

    const shouldUnpublish = displayedProjectStatus === 'published' || action === 'unpublish';

    if (shouldUnpublish) {
      const shouldUnpublish = window.confirm(`Unpublish project "${activeProject.fileName}"?`);
      if (!shouldUnpublish) {
        return;
      }
    }

    setSavingSettings(true);

    try {
      if (shouldUnpublish) {
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

    if (displayedProjectStatus !== 'unpublished') {
      return;
    }

    const shouldDelete = window.confirm(`Delete project "${activeProject.name}"? This cannot be undone.`);
    if (!shouldDelete) {
      return;
    }

    setDeletingProject(true);

    try {
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
        <div className="header-title">Projects</div>
        <div className="header-actions">
          {onCollapse ? (
            <Button
              appearance="subtle"
              spacing="compact"
              className="icon-button collapse-button"
              onClick={onCollapse}
              title="Collapse folders pane"
              aria-label="Collapse folders pane"
            >
              <ExpandLeftIcon />
            </Button>
          ) : null}
        </div>
      </div>

      {activeProject ? (
        <div className="active-project-section">
          <div className="active-project-section-content">
            <div className="active-project-details">
              <div className="active-project-label">Selected project</div>
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
              <LoadingButton
                appearance="primary"
                className="active-project-save-button"
                isDisabled={!editorReady}
                onClick={isActiveProjectOpen ? onSaveProject : () => onOpenProject(activeProject.absolutePath)}
                title={
                  !editorReady
                    ? 'Loading editor...'
                    : isActiveProjectOpen
                      ? 'Save current project'
                      : 'Open selected project in editor'
                }
                aria-label={
                  !editorReady
                    ? 'Loading editor'
                    : isActiveProjectOpen
                      ? 'Save current project'
                      : 'Open selected project in editor'
                }
              >
                {isActiveProjectOpen ? 'Save' : 'Edit'}
              </LoadingButton>
              <Button appearance="subtle" className="active-project-more-button" onClick={handleOpenSettings}>
                Settings
              </Button>
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
          <Button appearance="subtle-link" spacing="compact" className="link-button" onClick={() => void handleCreateFolder()}>
            + New folder
          </Button>
          {!editorReady ? <div className="body-status">Loading editor...</div> : null}
        </div>
        {bodyContent}
      </div>

      <ModalTransition>
        {settingsModalOpen && activeProject ? (
          <ModalDialog
            testId="workflow-project-settings-modal"
            width="medium"
            label={activeProject.fileName}
            onClose={closeSettingsModal}
            shouldCloseOnOverlayClick={!savingSettings && !deletingProject}
            shouldCloseOnEscapePress={!savingSettings && !deletingProject}
          >
            <ModalBody>
              <div className="project-settings-modal-shell">
                <div className="project-settings-modal-header-row">
                  <div className="project-settings-modal-heading">
                    {editingProjectName ? (
                      <div className="project-settings-title-field">
                        <TextField
                          className="project-settings-title-input"
                          value={projectNameDraft}
                          onChange={handleProjectNameDraftChange}
                          onBlur={() => void handleCommitProjectRename()}
                          onKeyDown={handleProjectNameKeyDown}
                          isInvalid={projectNameValidationError != null}
                          isDisabled={renamingProject || savingSettings || deletingProject}
                          autoFocus
                          spellCheck={false}
                        />
                        {projectNameValidationError ? <div className="project-settings-error">{projectNameValidationError}</div> : null}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="project-settings-title-button"
                        onClick={handleStartProjectRename}
                        disabled={renamingProject || savingSettings || deletingProject}
                        title={activeProject.fileName}
                      >
                        <span className="project-settings-modal-title">{activeProject.fileName}</span>
                      </button>
                    )}
                    <div className="active-project-status-row">
                      <span className={`project-status-badge ${displayedProjectStatus}`}>
                        {STATUS_LABELS[displayedProjectStatus]}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="project-settings-close-button"
                    onClick={closeSettingsModal}
                    disabled={savingSettings || deletingProject}
                    aria-label="Close project settings"
                  >
                    ×
                  </button>
                </div>

                <div className="project-settings-modal-content">
                  <div className="project-settings-field">
                    <label className="project-settings-label" htmlFor="workflow-project-endpoint-name">
                      Endpoint name
                    </label>
                    <div className="project-settings-input-row">
                      <TextField
                        id="workflow-project-endpoint-name"
                        className="project-settings-input"
                        value={settingsDraft.endpointName}
                        onChange={handleSettingsDraftChange('endpointName')}
                        isDisabled={savingSettings || deletingProject || displayedProjectStatus !== 'unpublished'}
                        isInvalid={displayedProjectStatus === 'unpublished' && endpointValidationError != null}
                        isCompact
                        spellCheck={false}
                      />
                      {displayedProjectStatus === 'published' ? (
                        <Button
                          appearance="subtle"
                          spacing="compact"
                          className="project-settings-copy-button"
                          onClick={() => void handleCopyEndpointName()}
                          isDisabled={savingSettings || deletingProject || settingsDraft.endpointName.trim().length === 0}
                        >
                          Copy
                        </Button>
                      ) : null}
                    </div>
                    {displayedProjectStatus !== 'unpublished' ? (
                      <div className="project-settings-help">Unpublish the project to change its endpoint.</div>
                    ) : null}
                    {endpointValidationError ? <div className="project-settings-error">{endpointValidationError}</div> : null}
                  </div>

                  <div className="project-settings-actions">
                    <Button
                      appearance="subtle"
                      className="project-settings-delete-button"
                      onClick={() => void handleDeleteActiveProject()}
                      isDisabled={disableDeleteProjectAction}
                      title={displayedProjectStatus !== 'unpublished' ? 'Unpublish the project before deleting it' : undefined}
                    >
                      {deletingProject ? 'Deleting...' : 'Delete project'}
                    </Button>
                    <div className="project-settings-action-group">
                      {showSecondaryUnpublishAction ? (
                        <Button
                          appearance="subtle"
                          className="project-settings-secondary-button"
                          onClick={() => void handlePrimarySettingsAction('unpublish')}
                          isDisabled={disableSecondaryUnpublishAction}
                        >
                          Unpublish
                        </Button>
                      ) : null}
                      <LoadingButton
                        appearance={displayedProjectStatus === 'published' ? 'subtle' : 'primary'}
                        className={`project-settings-primary-button${displayedProjectStatus === 'published' ? ' unpublish' : ''}`}
                        onClick={() => void handlePrimarySettingsAction('primary')}
                        isDisabled={disablePrimarySettingsAction}
                        isLoading={savingSettings}
                      >
                        {primarySettingsActionLabel}
                      </LoadingButton>
                    </div>
                  </div>
                </div>
              </div>
            </ModalBody>
          </ModalDialog>
        ) : null}
      </ModalTransition>
    </div>
  );
};
