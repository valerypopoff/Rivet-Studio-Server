import Button, { LoadingButton } from '@atlaskit/button';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import TextField from '@atlaskit/textfield';
import { type ChangeEvent, type FC, type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';

import {
  deleteWorkflowProject,
  publishWorkflowProject,
  renameWorkflowProject,
  unpublishWorkflowProject,
} from './workflowApi';
import type {
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettingsDraft,
  WorkflowProjectStatus,
} from './types';

const PROJECT_FILE_EXTENSION = '.rivet-project';
const ENDPOINT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const STATUS_LABELS: Record<WorkflowProjectStatus, string> = {
  unpublished: 'Unpublished',
  published: 'Published',
  unpublished_changes: 'Unpublished changes',
};

const getParentRelativePath = (relativePath: string) => {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const lastSlashIndex = normalized.lastIndexOf('/');
  return lastSlashIndex === -1 ? '' : normalized.slice(0, lastSlashIndex);
};

type ProjectSettingsModalProps = {
  activeProject: WorkflowProjectItem;
  allProjects: WorkflowProjectItem[];
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
  onDeleteProject: (path: string) => void;
  onWorkflowPathsMoved: (moves: WorkflowProjectPathMove[]) => void;
};

export const ProjectSettingsModal: FC<ProjectSettingsModalProps> = ({
  activeProject,
  allProjects,
  isOpen,
  onClose,
  onRefresh,
  onDeleteProject,
  onWorkflowPathsMoved,
}) => {
  const [settingsDraft, setSettingsDraft] = useState<WorkflowProjectSettingsDraft>({ endpointName: '' });
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [renamingProject, setRenamingProject] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

  useEffect(() => {
    setSettingsDraft({ endpointName: activeProject.settings.endpointName });
    setProjectNameDraft(activeProject.name);
    setEditingProjectName(false);
  }, [activeProject]);

  const normalizedDraftEndpointName = useMemo(
    () => settingsDraft.endpointName.trim().toLowerCase(),
    [settingsDraft.endpointName],
  );

  const endpointDuplicateProject = useMemo(() => {
    if (!normalizedDraftEndpointName) {
      return null;
    }

    return allProjects.find(
      (project) =>
        project.absolutePath !== activeProject.absolutePath &&
        project.settings.endpointName === normalizedDraftEndpointName,
    ) ?? null;
  }, [activeProject.absolutePath, allProjects, normalizedDraftEndpointName]);

  const normalizedProjectNameDraft = useMemo(() => {
    const trimmed = projectNameDraft.trim();
    return trimmed.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)
      ? trimmed.slice(0, -PROJECT_FILE_EXTENSION.length).trim()
      : trimmed;
  }, [projectNameDraft]);

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

  const displayedProjectStatus: WorkflowProjectStatus = activeProject.settings.status;
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
  const disableDeleteProjectAction = savingSettings || deletingProject;

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
    const shouldUnpublish = displayedProjectStatus === 'published' || action === 'unpublish';

    if (shouldUnpublish) {
      const shouldProceed = window.confirm(`Unpublish project "${activeProject.fileName}"?`);
      if (!shouldProceed) {
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
      await deleteWorkflowProject(activeProject.relativePath);
      onDeleteProject(activeProject.absolutePath);
      onClose();
      await onRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete project');
    } finally {
      setDeletingProject(false);
    }
  };

  return (
    <ModalTransition>
      {isOpen ? (
        <ModalDialog
          testId="workflow-project-settings-modal"
          width="medium"
          label={activeProject.fileName}
          onClose={onClose}
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
                  onClick={onClose}
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
  );
};
