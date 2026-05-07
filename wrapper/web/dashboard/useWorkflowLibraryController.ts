import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { cssTransition, toast } from 'react-toastify';
import {
  createWorkflowFolder,
  createWorkflowProject,
  deleteWorkflowFolder,
  downloadWorkflowProject,
  duplicateWorkflowProjectVersion,
  fetchWorkflowTree,
  moveWorkflowItem,
  renameWorkflowFolder,
  uploadWorkflowProject,
} from './workflowApi';
import type {
  WorkflowFolderItem,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
} from './types';
import {
  collectFolderIds,
  type DraggedWorkflowItem,
  flattenFolders,
  flattenProjects,
  normalizeWorkflowPath,
  ROOT_DROP_TARGET,
} from './workflowLibraryHelpers';
import { applyFolderMoveToTree, remapExpandedFolderIds } from './workflowTreeOps';

const PROJECT_SAVE_REFRESH_DELAY_MS = 150;

export const instantWarningToastTransition = cssTransition({
  enter: 'workflow-toast-instant-enter',
  exit: 'workflow-toast-instant-exit',
  collapse: false,
});

export type WorkflowProjectModalState = {
  mode: 'download' | 'duplicate';
  project: WorkflowProjectItem;
};

type WorkflowActionState = {
  projectPath: string | null;
  version: WorkflowProjectDownloadVersion | null;
};

type WorkflowDragState = {
  draggedItem: DraggedWorkflowItem | null;
  dropTargetFolderPath: string | null;
  dragOverRoot: boolean;
};

type WorkflowFolderContextMenuState = {
  folder: WorkflowFolderItem;
  x: number;
  y: number;
};

type WorkflowProjectContextMenuState = {
  project: WorkflowProjectItem;
  x: number;
  y: number;
};

function isFolderEmpty(folder: WorkflowFolderItem): boolean {
  return folder.folders.length === 0 && folder.projects.length === 0;
}

function normalizePromptValue(value: string | null): string | null {
  if (value == null) {
    return null;
  }

  const normalizedValue = value.trim();
  return normalizedValue || null;
}

async function pickWorkflowProjectFile(): Promise<File | null> {
  if ('showOpenFilePicker' in window) {
    try {
      const [fileHandle] = await (window as Window & {
        showOpenFilePicker?: (options?: Record<string, unknown>) => Promise<Array<{ getFile: () => Promise<File> }>>;
      }).showOpenFilePicker?.({
        multiple: false,
      }) ?? [];

      return fileHandle ? fileHandle.getFile() : null;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return null;
      }

      throw error;
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.rivet-project';
    input.style.display = 'none';

    let settled = false;
    let focusTimerId: number | null = null;
    const finish = (file: File | null) => {
      if (settled) {
        return;
      }

      settled = true;
      if (focusTimerId != null) {
        window.clearTimeout(focusTimerId);
        focusTimerId = null;
      }
      window.removeEventListener('focus', handleWindowFocus, true);
      input.remove();
      resolve(file);
    };

    const handleWindowFocus = () => {
      focusTimerId = window.setTimeout(() => {
        finish(input.files?.[0] ?? null);
      }, 300);
    };

    input.addEventListener('change', () => {
      finish(input.files?.[0] ?? null);
    }, { once: true });
    window.addEventListener('focus', handleWindowFocus, true);
    document.body.appendChild(input);
    input.click();
  });
}

export function useWorkflowLibraryController(options: {
  onOpenProject: (path: string, nextOptions?: { replaceCurrent?: boolean }) => void;
  onOpenRecording: (recordingId: string, nextOptions?: { replaceCurrent?: boolean }) => void;
  onDeleteProject: (path: string, projectId?: string | null) => void;
  onWorkflowPathsMoved: (moves: WorkflowProjectPathMove[]) => void;
  onActiveWorkflowProjectPathChange: (path: string) => void;
  openedProjectPath: string;
  projectSaveSequence: number;
}) {
  const {
    onOpenProject,
    onOpenRecording,
    onDeleteProject,
    onWorkflowPathsMoved,
    onActiveWorkflowProjectPathChange,
    openedProjectPath,
    projectSaveSequence,
  } = options;

  const [folders, setFolders] = useState<WorkflowFolderItem[]>([]);
  const [rootProjects, setRootProjects] = useState<WorkflowProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const projectRowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [dragState, setDragState] = useState<WorkflowDragState>({
    draggedItem: null,
    dropTargetFolderPath: null,
    dragOverRoot: false,
  });
  const [selectedProjectPath, setSelectedProjectPath] = useState('');
  const [settingsModalProject, setSettingsModalProject] = useState<WorkflowProjectItem | null>(null);
  const [runtimeLibsOpen, setRuntimeLibsOpen] = useState(false);
  const [runRecordingsOpen, setRunRecordingsOpen] = useState(false);
  const [folderContextMenuState, setFolderContextMenuState] = useState<WorkflowFolderContextMenuState | null>(null);
  const [projectContextMenuState, setProjectContextMenuState] = useState<WorkflowProjectContextMenuState | null>(null);
  const [uploadingFolderPath, setUploadingFolderPath] = useState<string | null>(null);
  const [projectModalState, setProjectModalState] = useState<WorkflowProjectModalState | null>(null);
  const [downloadState, setDownloadState] = useState<WorkflowActionState>({
    projectPath: null,
    version: null,
  });
  const [duplicateState, setDuplicateState] = useState<WorkflowActionState>({
    projectPath: null,
    version: null,
  });
  const refreshRequestIdRef = useRef(0);
  const projectSaveRefreshTimeoutRef = useRef<number | null>(null);

  const { draggedItem, dropTargetFolderPath, dragOverRoot } = dragState;
  const downloadingProjectPath = downloadState.projectPath;
  const downloadingVersion = downloadState.version;
  const duplicatingProjectPath = duplicateState.projectPath;
  const duplicatingVersion = duplicateState.version;
  const settingsModalOpen = settingsModalProject != null;

  const refresh = useCallback(async (
    showLoading = true,
    refreshOptions?: {
      preserveVisibleTreeOnError?: boolean;
      onError?: (message: string) => void;
    },
  ) => {
    const requestId = ++refreshRequestIdRef.current;
    const preserveVisibleTreeOnError = refreshOptions?.preserveVisibleTreeOnError ?? false;

    if (showLoading) {
      setLoading(true);
    }
    if (!preserveVisibleTreeOnError) {
      setError(null);
    }

    try {
      const tree = await fetchWorkflowTree();
      if (requestId !== refreshRequestIdRef.current) {
        return;
      }

      setFolders(tree.folders);
      setRootProjects(tree.projects);
      setExpandedFolders((prev) => {
        const validFolderIds = new Set(collectFolderIds(tree.folders));
        const next: Record<string, boolean> = {};
        let changed = false;

        for (const [folderId, isExpanded] of Object.entries(prev)) {
          if (validFolderIds.has(folderId)) {
            next[folderId] = isExpanded;
          } else {
            changed = true;
          }
        }

        for (const folderId of validFolderIds) {
          if (next[folderId] == null) {
            next[folderId] = false;
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    } catch (err: any) {
      if (requestId !== refreshRequestIdRef.current) {
        return;
      }

      const message = err.message || 'Failed to load workflow folders';
      if (!preserveVisibleTreeOnError) {
        setError(message);
      }
      refreshOptions?.onError?.(message);
    } finally {
      if (requestId === refreshRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scheduleProjectSaveRefresh = useCallback(() => {
    if (projectSaveRefreshTimeoutRef.current != null) {
      window.clearTimeout(projectSaveRefreshTimeoutRef.current);
    }

    projectSaveRefreshTimeoutRef.current = window.setTimeout(() => {
      projectSaveRefreshTimeoutRef.current = null;
      void refresh(false, {
        preserveVisibleTreeOnError: true,
        onError: (message) => {
          toast.error(message);
        },
      });
    }, PROJECT_SAVE_REFRESH_DELAY_MS);
  }, [refresh]);

  const reconcileWorkflowTreeInBackground = useCallback((message: string) => {
    void refresh(false, {
      preserveVisibleTreeOnError: true,
      onError: (errorMessage) => {
        toast.error(errorMessage || message);
      },
    });
  }, [refresh]);

  useEffect(() => () => {
    if (projectSaveRefreshTimeoutRef.current != null) {
      window.clearTimeout(projectSaveRefreshTimeoutRef.current);
    }
  }, []);

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
    if (projectSaveSequence === 0) {
      return;
    }

    scheduleProjectSaveRefresh();
  }, [projectSaveSequence, scheduleProjectSaveRefresh]);

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

  const canDropIntoFolder = useCallback((item: DraggedWorkflowItem | null, destinationFolderRelativePath: string) => {
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
  }, []);

  const resetDragState = useCallback(() => {
    setDragState({
      draggedItem: null,
      dropTargetFolderPath: null,
      dragOverRoot: false,
    });
  }, []);

  const toggleFolderExpanded = useCallback((folderId: string) => {
    setExpandedFolders((prev) => ({ ...prev, [folderId]: !(prev[folderId] ?? false) }));
  }, []);

  const handleMoveDraggedItem = useCallback(async (destinationFolderRelativePath: string) => {
    if (!canDropIntoFolder(draggedItem, destinationFolderRelativePath) || !draggedItem) {
      return;
    }

    try {
      const sourceFolder = draggedItem.itemType === 'folder'
        ? flattenedFolders.find((folder) => folder.relativePath === draggedItem.relativePath) ?? null
        : null;
      const result = await moveWorkflowItem(
        draggedItem.itemType,
        draggedItem.relativePath,
        destinationFolderRelativePath,
      );

      if (result.folder) {
        const movedFolder = result.folder;
        if (draggedItem.itemType === 'folder') {
          setExpandedFolders((prev) => {
            const next = remapExpandedFolderIds(prev, draggedItem.relativePath, movedFolder.relativePath);
            return {
              ...next,
              [movedFolder.id]: true,
            };
          });
        } else {
          setExpandedFolders((prev) => ({ ...prev, [movedFolder.id]: true }));
        }

        if (sourceFolder && draggedItem.itemType === 'folder') {
          const nextTree = applyFolderMoveToTree(folders, rootProjects, sourceFolder, movedFolder);
          setFolders(nextTree.folders);
          setRootProjects(nextTree.rootProjects);
        }
      }

      if (result.movedProjectPaths.length > 0) {
        setSelectedProjectPath((prev) => result.movedProjectPaths.find((move) => move.fromAbsolutePath === prev)?.toAbsolutePath ?? prev);
        setSettingsModalProject((prev) => {
          if (!prev) {
            return prev;
          }

          const nextPath = result.movedProjectPaths.find((move) => move.fromAbsolutePath === prev.absolutePath)?.toAbsolutePath;
          return nextPath ? { ...prev, absolutePath: nextPath } : prev;
        });
        onWorkflowPathsMoved(result.movedProjectPaths);
      }

      if (draggedItem.itemType === 'folder' && result.folder && sourceFolder) {
        reconcileWorkflowTreeInBackground('Workflow moved, but failed to refresh the tree');
      } else {
        await refresh(false);
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to move workflow item');
    } finally {
      resetDragState();
    }
  }, [
    canDropIntoFolder,
    draggedItem,
    flattenedFolders,
    folders,
    onWorkflowPathsMoved,
    reconcileWorkflowTreeInBackground,
    refresh,
    resetDragState,
    rootProjects,
  ]);

  const handleDragStart = useCallback((item: DraggedWorkflowItem) => (event: React.DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.relativePath);
    setDragState((prev) => ({ ...prev, draggedItem: item }));
  }, []);

  const handleDragEnd = useCallback(() => {
    resetDragState();
  }, [resetDragState]);

  const handleFolderDragOver = useCallback((folder: WorkflowFolderItem) => (event: React.DragEvent<HTMLElement>) => {
    if (!canDropIntoFolder(draggedItem, folder.relativePath)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDragState((prev) => ({
      ...prev,
      dropTargetFolderPath: folder.relativePath,
      dragOverRoot: false,
    }));
  }, [canDropIntoFolder, draggedItem]);

  const handleFolderDrop = useCallback((folder: WorkflowFolderItem) => async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    await handleMoveDraggedItem(folder.relativePath);
  }, [handleMoveDraggedItem]);

  const handleRootDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canDropIntoFolder(draggedItem, '')) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragState((prev) => ({
      ...prev,
      dropTargetFolderPath: ROOT_DROP_TARGET,
      dragOverRoot: true,
    }));
  }, [canDropIntoFolder, draggedItem]);

  const handleRootDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    await handleMoveDraggedItem('');
  }, [handleMoveDraggedItem]);

  const handleRootDragLeave = useCallback(() => {
    setDragState((prev) => ({ ...prev, dragOverRoot: false }));
    if (dropTargetFolderPath === ROOT_DROP_TARGET) {
      setDragState((prev) => ({ ...prev, dropTargetFolderPath: null }));
    }
  }, [dropTargetFolderPath]);

  const handleFolderDragLeave = useCallback((folder: WorkflowFolderItem) => {
    if (dropTargetFolderPath === folder.relativePath) {
      setDragState((prev) => ({ ...prev, dropTargetFolderPath: null }));
    }
  }, [dropTargetFolderPath]);

  const handleCreateFolder = useCallback(async () => {
    const name = normalizePromptValue(prompt('New folder name:'));
    if (!name) {
      return;
    }

    try {
      const folder = await createWorkflowFolder(name);
      setExpandedFolders((prev) => ({ ...prev, [folder.id]: true }));
      await refresh(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create folder');
    }
  }, [refresh]);

  const handleRenameFolder = useCallback(async (folder: WorkflowFolderItem) => {
    const newName = normalizePromptValue(prompt('Rename folder:', folder.name));
    if (!newName || newName === folder.name) {
      return;
    }

    try {
      const result = await renameWorkflowFolder(folder.relativePath, newName);
      const nextTree = applyFolderMoveToTree(folders, rootProjects, folder, result.folder);
      setFolders(nextTree.folders);
      setRootProjects(nextTree.rootProjects);
      setExpandedFolders((prev) => remapExpandedFolderIds(prev, folder.relativePath, result.folder.relativePath));
      if (result.movedProjectPaths.length > 0) {
        setSelectedProjectPath((prev) => result.movedProjectPaths.find((move) => move.fromAbsolutePath === prev)?.toAbsolutePath ?? prev);
        setSettingsModalProject((prev) => {
          if (!prev) {
            return prev;
          }

          const nextPath = result.movedProjectPaths.find((move) => move.fromAbsolutePath === prev.absolutePath)?.toAbsolutePath;
          return nextPath ? { ...prev, absolutePath: nextPath } : prev;
        });
        onWorkflowPathsMoved(result.movedProjectPaths);
      }
      reconcileWorkflowTreeInBackground('Folder renamed, but failed to refresh the tree');
    } catch (err: any) {
      toast.error(err.message || 'Failed to rename folder');
    }
  }, [folders, onWorkflowPathsMoved, reconcileWorkflowTreeInBackground, rootProjects]);

  const handleAddProject = useCallback(async (folder: WorkflowFolderItem) => {
    const name = normalizePromptValue(prompt(`New Rivet project name in folder "${folder.name}":`));
    if (!name) {
      return;
    }

    try {
      const project = await createWorkflowProject(folder.relativePath, name);
      setExpandedFolders((prev) => ({ ...prev, [folder.id]: true }));
      await refresh(false);
      onOpenProject(project.absolutePath);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create project');
    }
  }, [onOpenProject, refresh]);

  const handleDeleteFolder = useCallback(async (folder: WorkflowFolderItem) => {
    const shouldDelete = window.confirm(`Delete empty folder "${folder.name}"?`);
    if (!shouldDelete) {
      return;
    }

    try {
      await deleteWorkflowFolder(folder.relativePath);
      await refresh(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete folder');
    }
  }, [refresh]);

  const closeProjectContextMenu = useCallback(() => {
    setProjectContextMenuState(null);
  }, []);

  const closeFolderContextMenu = useCallback(() => {
    setFolderContextMenuState(null);
  }, []);

  const handleFolderContextMenu = useCallback((
    folder: WorkflowFolderItem,
    event: MouseEvent<HTMLDivElement>,
  ) => {
    if (duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    setProjectContextMenuState(null);
    setFolderContextMenuState({
      folder,
      x: event.clientX,
      y: event.clientY,
    });
  }, [downloadingProjectPath, duplicatingProjectPath, uploadingFolderPath]);

  const handleProjectContextMenu = useCallback((
    project: WorkflowProjectItem,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    setFolderContextMenuState(null);
    setProjectContextMenuState({
      project,
      x: event.clientX,
      y: event.clientY,
    });
  }, [downloadingProjectPath, duplicatingProjectPath, uploadingFolderPath]);

  const handleUploadProjectFromFolder = useCallback(async () => {
    const targetFolder = folderContextMenuState?.folder;
    if (!targetFolder || duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
      return;
    }

    closeFolderContextMenu();
    let selectedFile: File | null;
    try {
      selectedFile = await pickWorkflowProjectFile();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to open upload picker');
      return;
    }

    if (!selectedFile) {
      return;
    }

    if (!selectedFile.name.toLowerCase().endsWith('.rivet-project')) {
      toast.error('Choose a .rivet-project file to upload');
      return;
    }

    setUploadingFolderPath(targetFolder.relativePath);

    try {
      const contents = await selectedFile.text();
      await uploadWorkflowProject(targetFolder.relativePath, selectedFile.name, contents);
      await refresh(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to upload project');
    } finally {
      setUploadingFolderPath((currentPath) =>
        currentPath === targetFolder.relativePath ? null : currentPath);
    }
  }, [
    closeFolderContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    folderContextMenuState,
    refresh,
    uploadingFolderPath,
  ]);

  const handleCreateProjectFromContextMenu = useCallback(async () => {
    const targetFolder = folderContextMenuState?.folder;
    if (!targetFolder || duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
      return;
    }

    closeFolderContextMenu();
    await handleAddProject(targetFolder);
  }, [
    closeFolderContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    folderContextMenuState,
    handleAddProject,
    uploadingFolderPath,
  ]);

  const handleRenameFolderFromContextMenu = useCallback(async () => {
    const targetFolder = folderContextMenuState?.folder;
    if (!targetFolder || duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
      return;
    }

    closeFolderContextMenu();
    await handleRenameFolder(targetFolder);
  }, [
    closeFolderContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    folderContextMenuState,
    handleRenameFolder,
    uploadingFolderPath,
  ]);

  const handleDeleteFolderFromContextMenu = useCallback(async () => {
    const targetFolder = folderContextMenuState?.folder;
    if (!targetFolder || duplicatingProjectPath || downloadingProjectPath || uploadingFolderPath) {
      return;
    }

    if (!isFolderEmpty(targetFolder)) {
      toast.error('You can only delete empty folders', {
        transition: instantWarningToastTransition,
      });
      return;
    }

    closeFolderContextMenu();
    await handleDeleteFolder(targetFolder);
  }, [
    closeFolderContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    folderContextMenuState,
    handleDeleteFolder,
    uploadingFolderPath,
  ]);

  const closeProjectModal = useCallback(() => {
    if (downloadingVersion || duplicatingVersion) {
      return;
    }

    setProjectModalState(null);
  }, [downloadingVersion, duplicatingVersion]);

  const startDuplicateProject = useCallback(async (
    project: WorkflowProjectItem,
    version: WorkflowProjectDownloadVersion,
    startOptions?: { closeModal?: boolean },
  ) => {
    setDuplicateState({
      projectPath: project.relativePath,
      version,
    });

    try {
      await duplicateWorkflowProjectVersion(project.relativePath, version);
      if (startOptions?.closeModal) {
        setProjectModalState(null);
      }

      try {
        await refresh(false);
      } catch (refreshError: any) {
        toast.error(refreshError?.message || 'Project duplicated, but failed to refresh the tree');
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to duplicate project');
    } finally {
      setDuplicateState((current) =>
        current.projectPath === project.relativePath && current.version === version
          ? { projectPath: null, version: null }
          : current);
    }
  }, [refresh]);

  const handleDuplicateProject = useCallback(() => {
    const targetProject = projectContextMenuState?.project;
    if (!targetProject || duplicatingProjectPath || uploadingFolderPath) {
      return;
    }

    closeProjectContextMenu();

    if (targetProject.settings.status === 'unpublished_changes') {
      setProjectModalState({
        mode: 'duplicate',
        project: targetProject,
      });
      return;
    }

    void startDuplicateProject(
      targetProject,
      targetProject.settings.status === 'published' ? 'published' : 'live',
    );
  }, [
    closeProjectContextMenu,
    duplicatingProjectPath,
    projectContextMenuState,
    startDuplicateProject,
    uploadingFolderPath,
  ]);

  const startDownloadProject = useCallback(async (
    project: WorkflowProjectItem,
    version: WorkflowProjectDownloadVersion,
    startOptions?: { closeModal?: boolean },
  ) => {
    setDownloadState({
      projectPath: project.relativePath,
      version,
    });

    try {
      await downloadWorkflowProject(project.relativePath, version);
      if (startOptions?.closeModal) {
        setProjectModalState(null);
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to download project');
    } finally {
      setDownloadState((current) =>
        current.projectPath === project.relativePath && current.version === version
          ? { projectPath: null, version: null }
          : current);
    }
  }, []);

  const handleDownloadProject = useCallback(() => {
    const targetProject = projectContextMenuState?.project;
    if (!targetProject || downloadingProjectPath || duplicatingProjectPath || uploadingFolderPath) {
      return;
    }

    closeProjectContextMenu();

    if (targetProject.settings.status === 'unpublished_changes') {
      setProjectModalState({
        mode: 'download',
        project: targetProject,
      });
      return;
    }

    void startDownloadProject(
      targetProject,
      targetProject.settings.status === 'published' ? 'published' : 'live',
    );
  }, [
    closeProjectContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    projectContextMenuState,
    startDownloadProject,
    uploadingFolderPath,
  ]);

  const openProjectSettingsModal = useCallback((project: WorkflowProjectItem) => {
    setSettingsModalProject(project);
  }, []);

  const handleOpenSettings = useCallback(() => {
    if (!activeProject) {
      return;
    }

    setSettingsModalProject(activeProject);
  }, [activeProject]);

  const handleDeleteProjectFromContextMenu = useCallback(() => {
    const targetProject = projectContextMenuState?.project;
    if (!targetProject || downloadingProjectPath || duplicatingProjectPath || uploadingFolderPath) {
      return;
    }

    if (targetProject.settings.status !== 'unpublished') {
      toast.error('To delete a project, unpublish it first', {
        transition: instantWarningToastTransition,
      });
      return;
    }

    closeProjectContextMenu();
    openProjectSettingsModal(targetProject);
  }, [
    closeProjectContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    openProjectSettingsModal,
    projectContextMenuState,
    uploadingFolderPath,
  ]);

  const handleRenameProjectFromContextMenu = useCallback(() => {
    const targetProject = projectContextMenuState?.project;
    if (!targetProject || downloadingProjectPath || duplicatingProjectPath || uploadingFolderPath) {
      return;
    }

    closeProjectContextMenu();
    openProjectSettingsModal(targetProject);
  }, [
    closeProjectContextMenu,
    downloadingProjectPath,
    duplicatingProjectPath,
    openProjectSettingsModal,
    projectContextMenuState,
    uploadingFolderPath,
  ]);

  const handleWorkflowProjectPathsMoved = useCallback((moves: WorkflowProjectPathMove[]) => {
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
  }, [onWorkflowPathsMoved]);

  const closeSettingsModal = useCallback(() => {
    setSettingsModalProject(null);
  }, []);

  const projectModalProject = projectModalState?.project ?? null;
  const projectModalMode = projectModalState?.mode ?? 'download';
  const projectModalActiveVersion = projectModalProject == null
    ? null
    : projectModalMode === 'download'
      ? downloadingProjectPath === projectModalProject.relativePath ? downloadingVersion : null
      : duplicatingProjectPath === projectModalProject.relativePath ? duplicatingVersion : null;

  const handleProjectModalSelectPublished = useCallback(() => {
    if (!projectModalProject) {
      return;
    }

    if (projectModalMode === 'download') {
      void startDownloadProject(projectModalProject, 'published', { closeModal: true });
      return;
    }

    void startDuplicateProject(projectModalProject, 'published', { closeModal: true });
  }, [projectModalMode, projectModalProject, startDownloadProject, startDuplicateProject]);

  const handleProjectModalSelectUnpublishedChanges = useCallback(() => {
    if (!projectModalProject) {
      return;
    }

    if (projectModalMode === 'download') {
      void startDownloadProject(projectModalProject, 'live', { closeModal: true });
      return;
    }

    void startDuplicateProject(projectModalProject, 'live', { closeModal: true });
  }, [projectModalMode, projectModalProject, startDownloadProject, startDuplicateProject]);

  const setProjectRowRef = useCallback((projectPath: string, node: HTMLButtonElement | null) => {
    projectRowRefs.current[projectPath] = node;
  }, []);

  const handleFolderRowClick = useCallback((folder: WorkflowFolderItem) => (_event: MouseEvent<HTMLElement>) => {
    toggleFolderExpanded(folder.id);
  }, [toggleFolderExpanded]);

  const handleFolderRowKeyDown = useCallback(
    (folder: WorkflowFolderItem) => (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      toggleFolderExpanded(folder.id);
    },
    [toggleFolderExpanded],
  );

  return {
    folders,
    rootProjects,
    folderIds,
    allProjects,
    activePath,
    activeProject,
    loading,
    error,
    expandedFolders,
    draggedItem,
    dropTargetFolderPath,
    dragOverRoot,
    downloadingProjectPath,
    duplicatingProjectPath,
    uploadingFolderPath,
    settingsModalOpen,
    settingsModalProject,
    runtimeLibsOpen,
    runRecordingsOpen,
    folderContextMenuState,
    projectContextMenuState,
    projectModalProject,
    projectModalMode,
    projectModalActiveVersion,
    isActiveProjectOpen,
    refresh,
    handleCreateFolder,
    handleOpenSettings,
    closeSettingsModal,
    closeProjectContextMenu,
    closeFolderContextMenu,
    closeProjectModal,
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
    handleUploadProjectFromFolder,
    handleCreateProjectFromContextMenu,
    handleRenameFolderFromContextMenu,
    handleDeleteFolderFromContextMenu,
    handleRenameProjectFromContextMenu,
    handleDownloadProject,
    handleDuplicateProject,
    handleDeleteProjectFromContextMenu,
    handleProjectModalSelectPublished,
    handleProjectModalSelectUnpublishedChanges,
    setRuntimeLibsOpen,
    setRunRecordingsOpen,
    onOpenRecording: (recordingId: string) => {
      setRunRecordingsOpen(false);
      onOpenRecording(recordingId);
    },
    onProjectSelect: setSelectedProjectPath,
    onProjectOpen: onOpenProject,
    onWorkflowPathsMoved: handleWorkflowProjectPathsMoved,
    onDeleteProject,
    setProjectRowRef,
    isFolderEmpty,
  };
}
