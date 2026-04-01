import Button from '@atlaskit/button';
import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import CollapseLeftIcon from '../icons/arrow-collapse-left.svg?react';
import { toast } from 'react-toastify';
import { ActiveProjectSection } from './ActiveProjectSection';
import { WorkflowFolderTree } from './WorkflowFolderTree';
import { WorkflowProjectContextMenu } from './WorkflowProjectContextMenu';
import { WorkflowProjectDownloadModal } from './WorkflowProjectDownloadModal';
import { ProjectSettingsModal } from './ProjectSettingsModal';
import { RuntimeLibrariesModal } from './RuntimeLibrariesModal';
import { RunRecordingsModal } from './RunRecordingsModal';
import {
  createWorkflowFolder,
  createWorkflowProject,
  deleteWorkflowFolder,
  downloadWorkflowProject,
  duplicateWorkflowProject,
  fetchWorkflowTree,
  moveWorkflowItem,
  renameWorkflowFolder,
} from './workflowApi';
import type {
  WorkflowFolderItem,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
} from './types';
import {
  collectFolderIds,
  DraggedWorkflowItem,
  flattenFolders,
  flattenProjects,
  getParentRelativePath,
  normalizeWorkflowPath,
  ROOT_DROP_TARGET,
} from './workflowLibraryHelpers';
import './WorkflowLibraryPanel.css';

const markSavedPublishedProjectAsChanged = (
  project: WorkflowProjectItem,
  savedProjectPath: string,
): WorkflowProjectItem => {
  if (project.absolutePath !== savedProjectPath || project.settings.status !== 'published') {
    return project;
  }

  return {
    ...project,
    settings: {
      ...project.settings,
      status: 'unpublished_changes',
    },
  };
};

const updateSavedProjectStatus = (
  projects: WorkflowProjectItem[],
  savedProjectPath: string,
): WorkflowProjectItem[] => {
  let changed = false;
  const nextProjects = projects.map((project) => {
    const nextProject = markSavedPublishedProjectAsChanged(project, savedProjectPath);
    if (nextProject !== project) {
      changed = true;
    }
    return nextProject;
  });

  return changed ? nextProjects : projects;
};

const updateSavedProjectStatusInFolders = (
  folders: WorkflowFolderItem[],
  savedProjectPath: string,
): WorkflowFolderItem[] => {
  let changed = false;
  const nextFolders = folders.map((folder) => {
    const nextChildFolders = updateSavedProjectStatusInFolders(folder.folders, savedProjectPath);
    const nextProjects = updateSavedProjectStatus(folder.projects, savedProjectPath);

    if (nextChildFolders !== folder.folders || nextProjects !== folder.projects) {
      changed = true;
      return {
        ...folder,
        folders: nextChildFolders,
        projects: nextProjects,
      };
    }

    return folder;
  });

  return changed ? nextFolders : folders;
};

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
  lastSavedProjectPath: string;
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
  lastSavedProjectPath,
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
  const [runRecordingsOpen, setRunRecordingsOpen] = useState(false);
  const [projectContextMenuState, setProjectContextMenuState] = useState<{
    project: WorkflowProjectItem;
    x: number;
    y: number;
  } | null>(null);
  const [downloadModalProject, setDownloadModalProject] = useState<WorkflowProjectItem | null>(null);
  const [downloadingProjectPath, setDownloadingProjectPath] = useState<string | null>(null);
  const [downloadingVersion, setDownloadingVersion] = useState<WorkflowProjectDownloadVersion | null>(null);
  const [duplicatingProjectPath, setDuplicatingProjectPath] = useState<string | null>(null);
  const refreshRequestIdRef = useRef(0);

  const refresh = useCallback(async (showLoading = true) => {
    const requestId = ++refreshRequestIdRef.current;

    if (showLoading) {
      setLoading(true);
    }
    setError(null);

    try {
      const tree = await fetchWorkflowTree();
      if (requestId !== refreshRequestIdRef.current) {
        return;
      }

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
      if (requestId !== refreshRequestIdRef.current) {
        return;
      }

      setError(err.message || 'Failed to load workflow folders');
    } finally {
      if (requestId === refreshRequestIdRef.current) {
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
    if (projectSaveSequence === 0 || !lastSavedProjectPath) {
      return;
    }

    setRootProjects((prev) => updateSavedProjectStatus(prev, lastSavedProjectPath));
    setFolders((prev) => updateSavedProjectStatusInFolders(prev, lastSavedProjectPath));

    void refresh(false);
  }, [lastSavedProjectPath, projectSaveSequence, refresh]);

  const activeAncestorFolderIds = useMemo(() => {
    if (!activePath) {
      return [];
    }

    const normalizedActivePath = normalizeWorkflowPath(activePath);

    return flattenedFolders
      .filter((folder) => {
        const normalizedFolderPath = normalizeWorkflowPath(folder.absolutePath);
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

  const closeProjectContextMenu = useCallback(() => {
    setProjectContextMenuState(null);
  }, []);

  const handleProjectContextMenu = useCallback((
    project: WorkflowProjectItem,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    if (duplicatingProjectPath || downloadingProjectPath) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    setProjectContextMenuState({
      project,
      x: event.clientX,
      y: event.clientY,
    });
  }, [downloadingProjectPath, duplicatingProjectPath]);

  const closeDownloadModal = useCallback(() => {
    if (downloadingVersion) {
      return;
    }

    setDownloadModalProject(null);
  }, [downloadingVersion]);

  const handleDuplicateProject = useCallback(async () => {
    const targetProject = projectContextMenuState?.project;
    if (!targetProject || duplicatingProjectPath) {
      return;
    }

    closeProjectContextMenu();
    setDuplicatingProjectPath(targetProject.relativePath);

    try {
      await duplicateWorkflowProject(targetProject.relativePath);
      await refresh(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to duplicate project');
    } finally {
      setDuplicatingProjectPath((currentPath) =>
        currentPath === targetProject.relativePath ? null : currentPath);
    }
  }, [closeProjectContextMenu, duplicatingProjectPath, projectContextMenuState, refresh]);

  const startDownloadProject = useCallback(async (
    project: WorkflowProjectItem,
    version: WorkflowProjectDownloadVersion,
    options?: { closeModal?: boolean },
  ) => {
    setDownloadingProjectPath(project.relativePath);
    setDownloadingVersion(version);

    try {
      await downloadWorkflowProject(project.relativePath, version);
      if (options?.closeModal) {
        setDownloadModalProject(null);
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to download project');
    } finally {
      setDownloadingVersion((currentVersion) => currentVersion === version ? null : currentVersion);
      setDownloadingProjectPath((currentPath) => currentPath === project.relativePath ? null : currentPath);
    }
  }, []);

  const handleDownloadProject = useCallback(() => {
    const targetProject = projectContextMenuState?.project;
    if (!targetProject || downloadingProjectPath || duplicatingProjectPath) {
      return;
    }

    closeProjectContextMenu();

    if (targetProject.settings.status === 'unpublished_changes') {
      setDownloadModalProject(targetProject);
      return;
    }

    void startDownloadProject(
      targetProject,
      targetProject.settings.status === 'published' ? 'published' : 'live',
    );
  }, [closeProjectContextMenu, downloadingProjectPath, duplicatingProjectPath, projectContextMenuState, startDownloadProject]);

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
        setProjectRowRef={(path, node) => {
          projectRowRefs.current[path] = node;
        }}
        onProjectSelect={setSelectedProjectPath}
        onProjectOpen={onOpenProject}
        onProjectContextMenu={handleProjectContextMenu}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onFolderClick={handleFolderRowClick}
        onFolderKeyDown={handleFolderRowKeyDown}
        onFolderDragOver={handleFolderDragOver}
        onFolderDrop={(folder) => (event) => void handleFolderDrop(folder)(event)}
        onFolderDragLeave={(folder) => {
          if (dropTargetFolderPath === folder.relativePath) {
            setDropTargetFolderPath(null);
          }
        }}
        onFolderRename={(folder) => {
          void handleRenameFolder(folder);
        }}
        onFolderAddProject={(folder) => {
          void handleAddProject(folder);
        }}
        onFolderDelete={(folder) => {
          void handleDeleteFolder(folder);
        }}
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
      <RunRecordingsModal
        isOpen={runRecordingsOpen}
        onClose={() => setRunRecordingsOpen(false)}
        onOpenRecording={(recordingId) => {
          setRunRecordingsOpen(false);
          onOpenRecording(recordingId);
        }}
      />
      {projectContextMenuState ? (
        <WorkflowProjectContextMenu
          key={`${projectContextMenuState.project.relativePath}:${projectContextMenuState.x}:${projectContextMenuState.y}`}
          isOpen
          project={projectContextMenuState.project}
          x={projectContextMenuState.x}
          y={projectContextMenuState.y}
          onClose={closeProjectContextMenu}
          onDownload={() => void handleDownloadProject()}
          onDuplicate={() => void handleDuplicateProject()}
        />
      ) : null}
      <WorkflowProjectDownloadModal
        isOpen={downloadModalProject != null}
        project={downloadModalProject}
        downloadingVersion={downloadingProjectPath === downloadModalProject?.relativePath ? downloadingVersion : null}
        onClose={closeDownloadModal}
        onDownloadPublished={() => {
          if (!downloadModalProject) {
            return;
          }

          void startDownloadProject(downloadModalProject, 'published', { closeModal: true });
        }}
        onDownloadUnpublishedChanges={() => {
          if (!downloadModalProject) {
            return;
          }

          void startDownloadProject(downloadModalProject, 'live', { closeModal: true });
        }}
      />
    </div>
  );
};
