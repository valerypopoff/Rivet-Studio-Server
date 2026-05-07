import { useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { toast } from 'react-toastify';
import {
  deleteWorkflowProject,
  publishWorkflowProject,
  renameWorkflowProject,
  unpublishWorkflowProject,
} from './workflowApi';
import {
  normalizeProjectNameDraft,
  validateEndpointName,
  validateProjectName,
} from './projectSettingsForm';
import type {
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettingsDraft,
} from './types';
import { getParentRelativePath } from './workflowLibraryHelpers';

type UseProjectSettingsActionsOptions = {
  activeProject: WorkflowProjectItem;
  allProjects: WorkflowProjectItem[];
  isOpen: boolean;
  onClose: () => void;
  onDeleteProject: (path: string, projectId?: string | null) => void;
  onRefresh: () => void | Promise<void>;
  onWorkflowPathsMoved: (moves: WorkflowProjectPathMove[]) => void;
};

export function useProjectSettingsActions(options: UseProjectSettingsActionsOptions) {
  const {
    activeProject,
    allProjects,
    isOpen,
    onClose,
    onDeleteProject,
    onRefresh,
    onWorkflowPathsMoved,
  } = options;
  const [settingsDraft, setSettingsDraft] = useState<WorkflowProjectSettingsDraft>({ endpointName: '' });
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [showPublishSettings, setShowPublishSettings] = useState(false);
  const [renamingProject, setRenamingProject] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

  useEffect(() => {
    setSettingsDraft({ endpointName: activeProject.settings.endpointName });
    setProjectNameDraft(activeProject.name);
    setEditingProjectName(false);
    setShowPublishSettings(false);
  }, [activeProject, isOpen]);

  const trimmedDraftEndpointName = useMemo(() => settingsDraft.endpointName.trim(), [settingsDraft.endpointName]);
  const endpointLookupName = useMemo(() => trimmedDraftEndpointName.toLowerCase(), [trimmedDraftEndpointName]);

  const endpointDuplicateProject = useMemo(() => {
    if (!endpointLookupName) {
      return null;
    }

    return allProjects.find(
      (project) =>
        project.absolutePath !== activeProject.absolutePath &&
        project.settings.endpointName.trim().toLowerCase() === endpointLookupName,
    ) ?? null;
  }, [activeProject.absolutePath, allProjects, endpointLookupName]);

  const normalizedProjectNameDraft = useMemo(
    () => normalizeProjectNameDraft(projectNameDraft),
    [projectNameDraft],
  );

  const duplicateProjectNameInFolder = useMemo(() => {
    if (!normalizedProjectNameDraft) {
      return null;
    }

    const activeParentRelativePath = getParentRelativePath(activeProject.relativePath);

    return allProjects.find((project) => {
      if (project.absolutePath === activeProject.absolutePath) {
        return false;
      }

      return (
        getParentRelativePath(project.relativePath) === activeParentRelativePath &&
        project.name.toLowerCase() === normalizedProjectNameDraft.toLowerCase()
      );
    }) ?? null;
  }, [activeProject, allProjects, normalizedProjectNameDraft]);

  const projectNameValidationError = useMemo(() => {
    return validateProjectName(
      normalizedProjectNameDraft,
      duplicateProjectNameInFolder?.fileName ?? null,
      { enabled: editingProjectName },
    );
  }, [duplicateProjectNameInFolder, editingProjectName, normalizedProjectNameDraft]);

  const endpointValidationError = useMemo(() => {
    return validateEndpointName(
      trimmedDraftEndpointName,
      endpointDuplicateProject?.fileName ?? null,
    );
  }, [endpointDuplicateProject, trimmedDraftEndpointName]);

  const handleSettingsDraftChange =
    <K extends keyof WorkflowProjectSettingsDraft>(key: K) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value as WorkflowProjectSettingsDraft[K];
      setSettingsDraft((prev) => ({
        ...prev,
        [key]: value,
      }));
    };

  const handleProjectNameDraftChange = (event: ChangeEvent<HTMLInputElement>) => {
    setProjectNameDraft(event.target.value);
  };

  const handleStartProjectRename = () => {
    if (savingSettings || deletingProject || renamingProject) {
      return;
    }

    setProjectNameDraft(activeProject.name);
    setEditingProjectName(true);
  };

  const handleCommitProjectRename = async () => {
    const normalizedName = normalizedProjectNameDraft;
    if (!normalizedName || projectNameValidationError) {
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
      await onRefresh();
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

  const handleShowPublishSettings = () => {
    if (savingSettings || deletingProject) {
      return;
    }

    setShowPublishSettings(true);
  };

  const handlePublishProject = async (publishChanges = false) => {
    setSavingSettings(true);

    try {
      await publishWorkflowProject(activeProject.relativePath, {
        endpointName: publishChanges ? activeProject.settings.endpointName : settingsDraft.endpointName,
      });
      await onRefresh();
      setShowPublishSettings(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update project publication state');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleUnpublishProject = async () => {
    const shouldProceed = window.confirm(`Unpublish project "${activeProject.fileName}"?`);
    if (!shouldProceed) {
      return;
    }

    setSavingSettings(true);

    try {
      await unpublishWorkflowProject(activeProject.relativePath);
      await onRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update project publication state');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleDeleteActiveProject = async () => {
    const shouldDelete = window.confirm(`Delete project "${activeProject.name}"? This cannot be undone.`);
    if (!shouldDelete) {
      return;
    }

    setDeletingProject(true);

    try {
      const deletedProject = await deleteWorkflowProject(activeProject.relativePath);
      onDeleteProject(activeProject.absolutePath, deletedProject.projectId);
      onClose();
      await onRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete project');
    } finally {
      setDeletingProject(false);
    }
  };

  return {
    settingsDraft,
    projectNameDraft,
    editingProjectName,
    showPublishSettings,
    renamingProject,
    savingSettings,
    deletingProject,
    trimmedDraftEndpointName,
    normalizedProjectNameDraft,
    projectNameValidationError,
    endpointValidationError,
    handleSettingsDraftChange,
    handleProjectNameDraftChange,
    handleStartProjectRename,
    handleCommitProjectRename,
    handleProjectNameKeyDown,
    handleShowPublishSettings,
    handlePublishProject,
    handleUnpublishProject,
    handleDeleteActiveProject,
  };
}
