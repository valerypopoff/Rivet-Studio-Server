import Button from '@atlaskit/button';
import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import CollapseLeftIcon from '../icons/arrow-collapse-left.svg?react';
import { cssTransition, toast } from 'react-toastify';
import { ActiveProjectSection } from './ActiveProjectSection';
import { WorkflowFolderContextMenu } from './WorkflowFolderContextMenu';
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
  DraggedWorkflowItem,
  flattenFolders,
  flattenProjects,
  getParentRelativePath,
  normalizeWorkflowPath,
  ROOT_DROP_TARGET,
} from './workflowLibraryHelpers';
import './WorkflowLibraryPanel.css';

const PROJECT_SAVE_REFRESH_DELAY_MS = 150;
const instantWarningToastTransition = cssTransition({
  enter: 'workflow-toast-instant-enter',
  exit: 'workflow-toast-instant-exit',
  collapse: false,
});

const isFolderEmpty = (folder: WorkflowFolderItem): boolean =>
  folder.folders.length === 0 && folder.projects.length === 0;

const normalizePromptValue = (value: string | null): string | null => {
  if (value == null) {
    return null;
  }

  const normalizedValue = value.trim();
  return normalizedValue || null;
};

const remapExpandedFolderIds = (
  expandedFolders: Record<string, boolean>,
  fromRelativePath: string,
  toRelativePath: string,
): Record<string, boolean> => {
  const normalizedFromPath = normalizeWorkflowPath(fromRelativePath);
  const normalizedToPath = normalizeWorkflowPath(toRelativePath);

  if (normalizedFromPath === normalizedToPath) {
    return expandedFolders;
  }

  let changed = false;
  const nextExpandedFolders: Record<string, boolean> = {};

  for (const [folderId, isExpanded] of Object.entries(expandedFolders)) {
    const normalizedFolderId = normalizeWorkflowPath(folderId);

    if (
      normalizedFolderId === normalizedFromPath ||
      normalizedFolderId.startsWith(`${normalizedFromPath}/`)
    ) {
      const suffix = normalizedFolderId.slice(normalizedFromPath.length);
      nextExpandedFolders[`${normalizedToPath}${suffix}`] = isExpanded;
      changed = true;
      continue;
    }

    nextExpandedFolders[folderId] = isExpanded;
  }

  return changed ? nextExpandedFolders : expandedFolders;
};

const rewriteWorkflowPathPrefix = (value: string, fromPath: string, toPath: string): string => {
  const normalizedValue = normalizeWorkflowPath(value);
  const normalizedFromPath = normalizeWorkflowPath(fromPath);
  const normalizedToPath = normalizeWorkflowPath(toPath);

  if (normalizedValue === normalizedFromPath) {
    return normalizedToPath;
  }

  if (normalizedValue.startsWith(`${normalizedFromPath}/`)) {
    return `${normalizedToPath}${normalizedValue.slice(normalizedFromPath.length)}`;
  }

  return value;
};

const rewriteProjectForFolderMove = (
  project: WorkflowProjectItem,
  sourceFolder: WorkflowFolderItem,
  destinationFolder: WorkflowFolderItem,
): WorkflowProjectItem => ({
  ...project,
  relativePath: rewriteWorkflowPathPrefix(project.relativePath, sourceFolder.relativePath, destinationFolder.relativePath),
  absolutePath: rewriteWorkflowPathPrefix(project.absolutePath, sourceFolder.absolutePath, destinationFolder.absolutePath),
});

const rewriteFolderTreeForFolderMove = (
  folder: WorkflowFolderItem,
  sourceFolder: WorkflowFolderItem,
  destinationFolder: WorkflowFolderItem,
): WorkflowFolderItem => {
  const nextFolders = folder.folders.map((childFolder) =>
    rewriteFolderTreeForFolderMove(childFolder, sourceFolder, destinationFolder));
  const nextProjects = folder.projects.map((project) =>
    rewriteProjectForFolderMove(project, sourceFolder, destinationFolder));
  const normalizedFolderPath = normalizeWorkflowPath(folder.relativePath);
  const normalizedSourcePath = normalizeWorkflowPath(sourceFolder.relativePath);
  const isMovedFolder = normalizedFolderPath === normalizedSourcePath ||
    normalizedFolderPath.startsWith(`${normalizedSourcePath}/`);

  if (!isMovedFolder) {
    return {
      ...folder,
      folders: nextFolders,
      projects: nextProjects,
    };
  }

  const isMovedRoot = normalizedFolderPath === normalizedSourcePath;

  return {
    ...folder,
    id: rewriteWorkflowPathPrefix(folder.id, sourceFolder.relativePath, destinationFolder.relativePath),
    name: isMovedRoot ? destinationFolder.name : folder.name,
    relativePath: rewriteWorkflowPathPrefix(folder.relativePath, sourceFolder.relativePath, destinationFolder.relativePath),
    absolutePath: rewriteWorkflowPathPrefix(folder.absolutePath, sourceFolder.absolutePath, destinationFolder.absolutePath),
    updatedAt: isMovedRoot ? destinationFolder.updatedAt : folder.updatedAt,
    folders: nextFolders,
    projects: nextProjects,
  };
};

const detachFolderFromTree = (
  folders: WorkflowFolderItem[],
  sourceRelativePath: string,
): {
  folders: WorkflowFolderItem[];
  removedFolder: WorkflowFolderItem | null;
} => {
  const normalizedSourcePath = normalizeWorkflowPath(sourceRelativePath);
  let removedFolder: WorkflowFolderItem | null = null;
  let changed = false;

  const nextFolders: WorkflowFolderItem[] = [];

  for (const folder of folders) {
    if (normalizeWorkflowPath(folder.relativePath) === normalizedSourcePath) {
      removedFolder = folder;
      changed = true;
      continue;
    }

    const detachedChildren = detachFolderFromTree(folder.folders, sourceRelativePath);
    if (detachedChildren.removedFolder) {
      removedFolder = detachedChildren.removedFolder;
      changed = true;
      nextFolders.push({
        ...folder,
        folders: detachedChildren.folders,
      });
      continue;
    }

    nextFolders.push(folder);
  }

  return {
    folders: changed ? nextFolders : folders,
    removedFolder,
  };
};

const insertFolderIntoTree = (
  folders: WorkflowFolderItem[],
  parentRelativePath: string,
  folderToInsert: WorkflowFolderItem,
): {
  folders: WorkflowFolderItem[];
  inserted: boolean;
} => {
  const normalizedParentPath = normalizeWorkflowPath(parentRelativePath);

  if (!normalizedParentPath) {
    return {
      folders: [...folders, folderToInsert],
      inserted: true,
    };
  }

  let inserted = false;
  const nextFolders = folders.map((folder) => {
    if (normalizeWorkflowPath(folder.relativePath) === normalizedParentPath) {
      inserted = true;
      return {
        ...folder,
        folders: [...folder.folders, folderToInsert],
      };
    }

    const insertedChildren = insertFolderIntoTree(folder.folders, parentRelativePath, folderToInsert);
    if (!insertedChildren.inserted) {
      return folder;
    }

    inserted = true;
    return {
      ...folder,
      folders: insertedChildren.folders,
    };
  });

  return {
    folders: inserted ? nextFolders : folders,
    inserted,
  };
};

const applyFolderMoveToTree = (
  folders: WorkflowFolderItem[],
  rootProjects: WorkflowProjectItem[],
  sourceFolder: WorkflowFolderItem,
  destinationFolder: WorkflowFolderItem,
): {
  folders: WorkflowFolderItem[];
  rootProjects: WorkflowProjectItem[];
} => {
  const rewrittenInPlace = {
    folders: folders.map((folder) => rewriteFolderTreeForFolderMove(folder, sourceFolder, destinationFolder)),
    rootProjects: rootProjects.map((project) => rewriteProjectForFolderMove(project, sourceFolder, destinationFolder)),
  };
  const sourceParentRelativePath = getParentRelativePath(sourceFolder.relativePath);
  const destinationParentRelativePath = getParentRelativePath(destinationFolder.relativePath);

  if (normalizeWorkflowPath(sourceParentRelativePath) === normalizeWorkflowPath(destinationParentRelativePath)) {
    return rewrittenInPlace;
  }

  const detached = detachFolderFromTree(folders, sourceFolder.relativePath);
  if (!detached.removedFolder) {
    return rewrittenInPlace;
  }

  const movedFolder = rewriteFolderTreeForFolderMove(detached.removedFolder, sourceFolder, destinationFolder);
  const inserted = insertFolderIntoTree(detached.folders, destinationParentRelativePath, movedFolder);
  if (!inserted.inserted) {
    return rewrittenInPlace;
  }

  return {
    folders: inserted.folders,
    rootProjects,
  };
};

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
  const [folderContextMenuState, setFolderContextMenuState] = useState<{
    folder: WorkflowFolderItem;
    x: number;
    y: number;
  } | null>(null);
  const [projectContextMenuState, setProjectContextMenuState] = useState<{
    project: WorkflowProjectItem;
    x: number;
    y: number;
  } | null>(null);
  const [uploadingFolderPath, setUploadingFolderPath] = useState<string | null>(null);
  const [downloadModalProject, setDownloadModalProject] = useState<WorkflowProjectItem | null>(null);
  const [duplicateModalProject, setDuplicateModalProject] = useState<WorkflowProjectItem | null>(null);
  const [downloadingProjectPath, setDownloadingProjectPath] = useState<string | null>(null);
  const [downloadingVersion, setDownloadingVersion] = useState<WorkflowProjectDownloadVersion | null>(null);
  const [duplicatingProjectPath, setDuplicatingProjectPath] = useState<string | null>(null);
  const [duplicatingVersion, setDuplicatingVersion] = useState<WorkflowProjectDownloadVersion | null>(null);
  const refreshRequestIdRef = useRef(0);
  const projectSaveRefreshTimeoutRef = useRef<number | null>(null);

  const refresh = useCallback(async (
    showLoading = true,
    options?: {
      preserveVisibleTreeOnError?: boolean;
      onError?: (message: string) => void;
    },
  ) => {
    const requestId = ++refreshRequestIdRef.current;
    const preserveVisibleTreeOnError = options?.preserveVisibleTreeOnError ?? false;

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
      options?.onError?.(message);
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

  const handleFolderRowClick = (folder: WorkflowFolderItem) => (_event: React.MouseEvent<HTMLElement>) => {
    toggleFolderExpanded(folder.id);
  };

  const handleFolderRowKeyDown =
    (folder: WorkflowFolderItem) => (event: React.KeyboardEvent<HTMLDivElement>) => {
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
        handleWorkflowProjectPathsMoved(result.movedProjectPaths);
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
  };

  const handleRenameFolder = async (folder: WorkflowFolderItem) => {
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
        handleWorkflowProjectPathsMoved(result.movedProjectPaths);
      }
      reconcileWorkflowTreeInBackground('Folder renamed, but failed to refresh the tree');
    } catch (err: any) {
      toast.error(err.message || 'Failed to rename folder');
    }
  };

  const handleAddProject = async (folder: WorkflowFolderItem) => {
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
  };

  const handleDeleteFolder = async (folder: WorkflowFolderItem) => {
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
  };

  const closeProjectContextMenu = useCallback(() => {
    setProjectContextMenuState(null);
  }, []);

  const closeFolderContextMenu = useCallback(() => {
    setFolderContextMenuState(null);
  }, []);

  const handleFolderContextMenu = useCallback((
    folder: WorkflowFolderItem,
    event: React.MouseEvent<HTMLDivElement>,
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
    event: React.MouseEvent<HTMLButtonElement>,
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

  const handleCreateProjectFromFolder = useCallback(async () => {
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

  const closeDownloadModal = useCallback(() => {
    if (downloadingVersion) {
      return;
    }

    setDownloadModalProject(null);
  }, [downloadingVersion]);

  const closeDuplicateModal = useCallback(() => {
    if (duplicatingVersion) {
      return;
    }

    setDuplicateModalProject(null);
  }, [duplicatingVersion]);

  const startDuplicateProject = useCallback(async (
    project: WorkflowProjectItem,
    version: WorkflowProjectDownloadVersion,
    options?: { closeModal?: boolean },
  ) => {
    setDuplicatingProjectPath(project.relativePath);
    setDuplicatingVersion(version);

    try {
      await duplicateWorkflowProjectVersion(project.relativePath, version);
      if (options?.closeModal) {
        setDuplicateModalProject(null);
      }

      try {
        await refresh(false);
      } catch (refreshError: any) {
        toast.error(refreshError?.message || 'Project duplicated, but failed to refresh the tree');
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to duplicate project');
    } finally {
      setDuplicatingVersion((currentVersion) => currentVersion === version ? null : currentVersion);
      setDuplicatingProjectPath((currentPath) => currentPath === project.relativePath ? null : currentPath);
    }
  }, [refresh]);

  const handleDuplicateProject = useCallback(() => {
    const targetProject = projectContextMenuState?.project;
    if (!targetProject || duplicatingProjectPath || uploadingFolderPath) {
      return;
    }

    closeProjectContextMenu();

    if (targetProject.settings.status === 'unpublished_changes') {
      setDownloadModalProject(null);
      setDuplicateModalProject(targetProject);
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
    if (!targetProject || downloadingProjectPath || duplicatingProjectPath || uploadingFolderPath) {
      return;
    }

    closeProjectContextMenu();

    if (targetProject.settings.status === 'unpublished_changes') {
      setDuplicateModalProject(null);
      setDownloadModalProject(targetProject);
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

  const handleOpenSettings = () => {
    if (!activeProject) {
      return;
    }

    setSettingsModalProject(activeProject);
    setSettingsModalOpen(true);
  };

  const openProjectSettingsModal = useCallback((project: WorkflowProjectItem) => {
    setSettingsModalProject(project);
    setSettingsModalOpen(true);
  }, []);

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
        onFolderContextMenu={handleFolderContextMenu}
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
      {folderContextMenuState ? (
        <WorkflowFolderContextMenu
          key={`${folderContextMenuState.folder.relativePath}:${folderContextMenuState.x}:${folderContextMenuState.y}`}
          isOpen
          folder={folderContextMenuState.folder}
          x={folderContextMenuState.x}
          y={folderContextMenuState.y}
          onClose={closeFolderContextMenu}
          canDelete={isFolderEmpty(folderContextMenuState.folder)}
          onRename={() => void handleRenameFolderFromContextMenu()}
          onCreateProject={() => void handleCreateProjectFromFolder()}
          onUploadProject={() => void handleUploadProjectFromFolder()}
          onDelete={() => void handleDeleteFolderFromContextMenu()}
        />
      ) : null}
      {projectContextMenuState ? (
        <WorkflowProjectContextMenu
          key={`${projectContextMenuState.project.relativePath}:${projectContextMenuState.x}:${projectContextMenuState.y}`}
          isOpen
          project={projectContextMenuState.project}
          x={projectContextMenuState.x}
          y={projectContextMenuState.y}
          onClose={closeProjectContextMenu}
          onRename={() => void handleRenameProjectFromContextMenu()}
          onDownload={() => void handleDownloadProject()}
          onDuplicate={() => void handleDuplicateProject()}
          canDelete={projectContextMenuState.project.settings.status === 'unpublished'}
          onDelete={() => void handleDeleteProjectFromContextMenu()}
        />
      ) : null}
      <WorkflowProjectDownloadModal
        isOpen={downloadModalProject != null}
        project={downloadModalProject}
        actionLabel="Download"
        activeVersion={downloadingProjectPath === downloadModalProject?.relativePath ? downloadingVersion : null}
        onClose={closeDownloadModal}
        onSelectPublished={() => {
          if (!downloadModalProject) {
            return;
          }

          void startDownloadProject(downloadModalProject, 'published', { closeModal: true });
        }}
        onSelectUnpublishedChanges={() => {
          if (!downloadModalProject) {
            return;
          }

          void startDownloadProject(downloadModalProject, 'live', { closeModal: true });
        }}
      />
      <WorkflowProjectDownloadModal
        isOpen={duplicateModalProject != null}
        project={duplicateModalProject}
        actionLabel="Duplicate"
        activeVersion={duplicatingProjectPath === duplicateModalProject?.relativePath ? duplicatingVersion : null}
        onClose={closeDuplicateModal}
        onSelectPublished={() => {
          if (!duplicateModalProject) {
            return;
          }

          void startDuplicateProject(duplicateModalProject, 'published', { closeModal: true });
        }}
        onSelectUnpublishedChanges={() => {
          if (!duplicateModalProject) {
            return;
          }

          void startDuplicateProject(duplicateModalProject, 'live', { closeModal: true });
        }}
      />
    </div>
  );
};
