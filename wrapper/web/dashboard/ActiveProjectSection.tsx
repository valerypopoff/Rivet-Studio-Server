import Button, { LoadingButton } from '@atlaskit/button';
import { type FC } from 'react';

import type { WorkflowProjectItem, WorkflowProjectStatus } from './types';

const STATUS_LABELS: Record<WorkflowProjectStatus, string> = {
  unpublished: 'Unpublished',
  published: 'Published',
  unpublished_changes: 'Unpublished changes',
};

type ActiveProjectSectionProps = {
  activeProject: WorkflowProjectItem;
  isCurrentlyOpen: boolean;
  editorReady: boolean;
  onSave: () => void;
  onOpen: (path: string) => void;
  onOpenSettings: () => void;
};

export const ActiveProjectSection: FC<ActiveProjectSectionProps> = ({
  activeProject,
  isCurrentlyOpen,
  editorReady,
  onSave,
  onOpen,
  onOpenSettings,
}) => {
  const statusLabel = STATUS_LABELS[activeProject.settings.status];
  const baseName = activeProject.fileName.replace(/\.[^.]+$/, '');

  return (
    <div className="active-project-section">
      <div className="active-project-section-content">
        <div className="active-project-details">
          <div className="active-project-name-row" title={`${statusLabel} ${baseName}`}>
            <span className={`project-status-badge ${activeProject.settings.status}`}>
              {statusLabel}
            </span>
            <span className="active-project-name">{baseName}</span>
          </div>
          <div className="active-project-actions-row">
            <LoadingButton
              appearance="primary"
              className="active-project-save-button"
              isDisabled={!editorReady}
              onClick={isCurrentlyOpen ? onSave : () => onOpen(activeProject.absolutePath)}
              title={
                !editorReady
                  ? 'Loading editor...'
                  : isCurrentlyOpen
                    ? 'Save current project'
                    : 'Open selected project in editor'
              }
              aria-label={
                !editorReady
                  ? 'Loading editor'
                  : isCurrentlyOpen
                    ? 'Save current project'
                    : 'Open selected project in editor'
              }
            >
              {isCurrentlyOpen ? 'Save' : 'Edit'}
            </LoadingButton>
            <Button appearance="subtle" className="active-project-more-button" onClick={onOpenSettings}>
              Settings
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
