import Button, { LoadingButton } from '@atlaskit/button';
import EditIcon from '@atlaskit/icon/glyph/editor/edit';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import TextField from '@atlaskit/textfield';
import { type FC, useMemo, type ReactNode } from 'react';

import {
  RIVET_LATEST_WORKFLOWS_BASE_PATH,
  RIVET_PUBLISHED_WORKFLOWS_BASE_PATH,
} from '../../shared/hosted-env';
import {
  formatLastPublishedAtLabel,
  getWorkflowProjectStatusLabel,
} from './projectSettingsForm';
import type {
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectStatus,
} from './types';
import { useProjectSettingsActions } from './useProjectSettingsActions';

const renderStatusExplanation = (status: WorkflowProjectStatus, endpointName: string): ReactNode => {
  switch (status) {
    case 'unpublished':
      return 'The workflow is not published as an endpoint.';
    case 'published':
      return (
        <>
          The workflow is accessible via the endpoint on 
          <br />
          <code className="project-settings-endpoint-code">
            {`${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}/${endpointName}`}
          </code>
          <br />
          <br />
          To change the endpoint path, unpublish it.
        </>
      );

    case 'unpublished_changes':
      return (
        <>
          Workflow has changes that are not live. 
          <br />
          <br />
          The published workflow version is still accessible on 
          <br />
          <code className="project-settings-endpoint-code">
            {`${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}/${endpointName}`}
          </code>
          <br />
          <br />
          The unpublished changes are accessible on 
          <br />
          <code className="project-settings-endpoint-code">
            {`${RIVET_LATEST_WORKFLOWS_BASE_PATH}/${endpointName}`}
          </code>
        </>
      );
    default:
      return null;
  }
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
  const {
    settingsDraft,
    projectNameDraft,
    editingProjectName,
    showPublishSettings,
    renamingProject,
    savingSettings,
    deletingProject,
    handleSettingsDraftChange,
    handleProjectNameDraftChange,
    handleStartProjectRename,
    handleCommitProjectRename,
    handleProjectNameKeyDown,
    handleShowPublishSettings,
    handlePublishProject,
    handleUnpublishProject,
    handleDeleteActiveProject,
    projectNameValidationError,
    endpointValidationError,
  } = useProjectSettingsActions({
    activeProject,
    allProjects,
    isOpen,
    onClose,
    onDeleteProject,
    onRefresh,
    onWorkflowPathsMoved,
  });

  const displayedProjectStatus: WorkflowProjectStatus = activeProject.settings.status;
  const baseFileName = useMemo(() => activeProject.fileName.replace(/\.[^.]+$/, ''), [activeProject.fileName]);
  const displayedEndpointName = useMemo(
    () => settingsDraft.endpointName.trim() || activeProject.settings.endpointName || 'endpoint-name',
    [activeProject.settings.endpointName, settingsDraft.endpointName],
  );
  const isUnpublishedProject = displayedProjectStatus === 'unpublished';
  const isPublishedProject = displayedProjectStatus === 'published';
  const isUnpublishedChangesProject = displayedProjectStatus === 'unpublished_changes';
  const lastPublishedAtLabel = useMemo(
    () => formatLastPublishedAtLabel(displayedProjectStatus, activeProject.settings.lastPublishedAt),
    [activeProject.settings.lastPublishedAt, displayedProjectStatus],
  );
  const shouldShowPublishSettings = isUnpublishedProject && showPublishSettings;
  const canCloseModal = !savingSettings && !deletingProject && !editingProjectName && !renamingProject;
  const disablePublishAction = savingSettings || deletingProject || endpointValidationError != null;
  const disablePublishChangesAction = savingSettings || deletingProject;
  const disableUnpublishAction = savingSettings || deletingProject;
  const disableDeleteProjectAction = savingSettings || deletingProject || !isUnpublishedProject;

  return (
    <ModalTransition>
      {isOpen ? (
        <ModalDialog
          testId="workflow-project-settings-modal"
          width="medium"
          label={baseFileName}
          onClose={onClose}
          shouldCloseOnOverlayClick={canCloseModal}
          shouldCloseOnEscapePress={canCloseModal}
        >
          <ModalBody>
            <div className="project-settings-modal-shell">
              <div className="project-settings-modal-header-row">
                <div className="project-settings-modal-heading">
                  <div className={`project-settings-title-display${editingProjectName ? ' editing' : ''}`} title={baseFileName}>
                    <div className="project-settings-title-field">
                      <span className={`project-settings-modal-title${editingProjectName ? ' editing' : ''}`}>{baseFileName}</span>
                      {editingProjectName ? (
                        <div className="project-settings-title-input-overlay">
                          <TextField
                            className="project-settings-title-input"
                            value={projectNameDraft}
                            onChange={handleProjectNameDraftChange}
                            onBlur={() => void handleCommitProjectRename()}
                            onKeyDown={handleProjectNameKeyDown}
                            isInvalid={projectNameValidationError != null}
                            isDisabled={renamingProject || savingSettings || deletingProject}
                            isCompact
                            autoFocus
                            spellCheck={false}
                          />
                        </div>
                      ) : null}
                    </div>
                    {!editingProjectName ? (
                      <Button
                        appearance="subtle"
                        spacing="compact"
                        className="project-settings-rename-button button-size-m"
                        onClick={handleStartProjectRename}
                        isDisabled={renamingProject || savingSettings || deletingProject}
                        iconBefore={<EditIcon label="" size="medium" />}
                        aria-label="Rename project"
                      >
                        Edit
                      </Button>
                    ) : null}
                  </div>
                  {projectNameValidationError ? <div className="project-settings-error">{projectNameValidationError}</div> : null}
                </div>
                <button
                  type="button"
                  className="project-settings-close-button"
                  onClick={onClose}
                  disabled={!canCloseModal}
                  aria-label="Close project settings"
                >
                  ×
                </button>
              </div>

              <div className="project-settings-modal-content">
                <div className="project-settings-status-block">
                  <div className="active-project-status-row">
                    <span className={`project-status-badge ${displayedProjectStatus}`}>
                      {getWorkflowProjectStatusLabel(displayedProjectStatus)}
                    </span>
                    {lastPublishedAtLabel ? (
                      <span className="project-settings-last-published-at">{lastPublishedAtLabel}</span>
                    ) : null}
                  </div>
                  <div className="project-settings-help project-settings-status-help">
                    {renderStatusExplanation(displayedProjectStatus, displayedEndpointName)}
                  </div>
                </div>

                {shouldShowPublishSettings ? (
                  <div className="project-settings-field">
                    <label className="project-settings-label" htmlFor="workflow-project-endpoint-name">
                      Endpoint path
                    </label>
                    <div className="project-settings-input-row">
                      <TextField
                        id="workflow-project-endpoint-name"
                        className="project-settings-input text-field-size-l"
                        value={settingsDraft.endpointName}
                        onChange={handleSettingsDraftChange('endpointName')}
                        isDisabled={savingSettings || deletingProject}
                        isInvalid={endpointValidationError != null}
                        spellCheck={false}
                      />
                      <LoadingButton
                        appearance="primary"
                        className="project-settings-primary-button button-size-l"
                        onClick={() => void handlePublishProject(false)}
                        isDisabled={disablePublishAction}
                        isLoading={savingSettings}
                      >
                        Publish
                      </LoadingButton>
                    </div>
                    {endpointValidationError ? <div className="project-settings-error">{endpointValidationError}</div> : null}
                  </div>
                ) : null}

                <div className="project-settings-actions">
                  <div className="project-settings-action-group">
                    {isUnpublishedProject && !shouldShowPublishSettings ? (
                      <Button
                        appearance="primary"
                        className="project-settings-primary-button button-size-l"
                        onClick={handleShowPublishSettings}
                        isDisabled={savingSettings || deletingProject}
                      >
                        Publish...
                      </Button>
                    ) : null}
                    {isPublishedProject ? (
                      <LoadingButton
                        appearance="primary"
                        className="project-settings-primary-button button-size-l"
                        onClick={() => void handleUnpublishProject()}
                        isDisabled={disableUnpublishAction}
                        isLoading={savingSettings}
                      >
                        Unpublish
                      </LoadingButton>
                    ) : null}
                    {isUnpublishedChangesProject ? (
                      <LoadingButton
                        appearance="primary"
                        className="project-settings-primary-button button-size-l"
                        onClick={() => void handlePublishProject(true)}
                        isDisabled={disablePublishChangesAction}
                        isLoading={savingSettings}
                      >
                        Publish changes
                      </LoadingButton>
                    ) : null}
                    {isUnpublishedChangesProject ? (
                      <Button
                        appearance="subtle"
                        className="project-settings-secondary-button button-size-l"
                        onClick={() => void handleUnpublishProject()}
                        isDisabled={disableUnpublishAction}
                      >
                        Unpublish
                      </Button>
                    ) : null}
                  </div>
                  {isUnpublishedProject && !shouldShowPublishSettings ? (
                    <Button
                      appearance="subtle"
                      className="project-settings-delete-button button-size-l"
                      onClick={() => void handleDeleteActiveProject()}
                      isDisabled={disableDeleteProjectAction}
                    >
                      {deletingProject ? 'Deleting...' : 'Delete project'}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </ModalBody>
        </ModalDialog>
      ) : null}
    </ModalTransition>
  );
};
