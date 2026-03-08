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
  return (
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
            More
          </Button>
        </div>
      </div>
    </div>
  );
};
