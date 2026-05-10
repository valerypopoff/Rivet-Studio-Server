import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import type { FC } from 'react';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const appVersion = import.meta.env.VITE_APP_VERSION || 'unknown';
const appName = 'Rivet Studio Server';

export const AboutModal: FC<AboutModalProps> = ({
  isOpen,
  onClose,
}) => {
  if (!isOpen) {
    return null;
  }

  return (
    <ModalTransition>
      <ModalDialog
        testId="about-modal"
        width="small"
        label="About"
        onClose={onClose}
      >
        <ModalBody>
          <div className="project-settings-modal-shell about-modal-shell">
            <div className="project-settings-modal-header-row about-modal-header-row">
              <div className="project-settings-modal-heading">
                <div className="project-settings-modal-title">About</div>
              </div>
              <button
                type="button"
                className="project-settings-close-button"
                onClick={onClose}
                aria-label="Close about"
              >
                &times;
              </button>
            </div>

            <div className="project-settings-modal-content about-modal-content">
              <div className="about-detail-row">
                <span className="about-detail-label">Name</span>
                <span className="about-detail-value">{appName}</span>
              </div>
              <div className="about-detail-row">
                <span className="about-detail-label">Version</span>
                <span className="about-detail-value">{appVersion}</span>
              </div>
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
