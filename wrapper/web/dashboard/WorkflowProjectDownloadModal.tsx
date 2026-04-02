import Button, { LoadingButton } from '@atlaskit/button';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import { type FC } from 'react';
import type { WorkflowProjectItem } from './types';

type WorkflowProjectDownloadModalProps = {
  isOpen: boolean;
  project: WorkflowProjectItem | null;
  downloadingVersion: 'live' | 'published' | null;
  onClose: () => void;
  onDownloadPublished: () => void;
  onDownloadUnpublishedChanges: () => void;
};

export const WorkflowProjectDownloadModal: FC<WorkflowProjectDownloadModalProps> = ({
  isOpen,
  project,
  downloadingVersion,
  onClose,
  onDownloadPublished,
  onDownloadUnpublishedChanges,
}) => {
  if (!isOpen || !project) {
    return null;
  }

  const canClose = downloadingVersion == null;

  return (
    <ModalTransition>
      <ModalDialog
        testId="workflow-project-download-modal"
        width="medium"
        label={`Download ${project.name}`}
        onClose={onClose}
        shouldCloseOnOverlayClick={canClose}
        shouldCloseOnEscapePress={canClose}
      >
        <ModalBody>
          <div className="project-settings-modal-shell">
            <div className="project-settings-modal-header-row">
              <div className="project-settings-modal-heading">
                <div className="project-settings-modal-title" title={project.name}>
                  Download
                </div>
              </div>
              <button
                type="button"
                className="project-settings-close-button"
                onClick={onClose}
                disabled={!canClose}
                aria-label="Close project download chooser"
              >
                {'\u00d7'}
              </button>
            </div>

            <div className="project-settings-modal-content workflow-project-download-modal-content">
              <div className="project-settings-help workflow-project-download-help">
                {project.name}: choose which saved version to download. Unsaved editor changes are not included.
              </div>

              <div className="workflow-project-download-actions">
                <LoadingButton
                  appearance="primary"
                  className="project-settings-primary-button button-size-l workflow-project-download-published-button"
                  onClick={onDownloadPublished}
                  isDisabled={downloadingVersion != null}
                  isLoading={downloadingVersion === 'published'}
                >
                  Download "Published"
                </LoadingButton>
                <LoadingButton
                  appearance="subtle"
                  className="project-settings-secondary-button button-size-l workflow-project-download-secondary-button workflow-project-download-live-button"
                  onClick={onDownloadUnpublishedChanges}
                  isDisabled={downloadingVersion != null}
                  isLoading={downloadingVersion === 'live'}
                >
                  Download "Unpublished changes"
                </LoadingButton>
              </div>

              <div className="workflow-project-download-footer">
                <Button
                  appearance="subtle"
                  className="project-settings-secondary-button button-size-l"
                  onClick={onClose}
                  isDisabled={!canClose}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
