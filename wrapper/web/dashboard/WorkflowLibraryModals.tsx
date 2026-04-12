import type { FC } from 'react';
import { ProjectSettingsModal } from './ProjectSettingsModal';
import { RuntimeLibrariesModal } from './RuntimeLibrariesModal';
import { RunRecordingsModal } from './RunRecordingsModal';
import { WorkflowProjectDownloadModal } from './WorkflowProjectDownloadModal';
import { useWorkflowLibraryController } from './useWorkflowLibraryController';

type WorkflowLibraryController = ReturnType<typeof useWorkflowLibraryController>;

export const WorkflowLibraryModals: FC<{
  controller: WorkflowLibraryController;
}> = ({ controller }) => {
  const {
    settingsModalOpen,
    settingsModalProject,
    allProjects,
    closeSettingsModal,
    refresh,
    onDeleteProject,
    onWorkflowPathsMoved,
    runtimeLibsOpen,
    setRuntimeLibsOpen,
    runRecordingsOpen,
    setRunRecordingsOpen,
    onOpenRecording,
    projectModalProject,
    projectModalMode,
    projectModalActiveVersion,
    closeProjectModal,
    handleProjectModalSelectPublished,
    handleProjectModalSelectUnpublishedChanges,
  } = controller;

  return (
    <>
      {settingsModalOpen && settingsModalProject ? (
        <ProjectSettingsModal
          activeProject={settingsModalProject}
          allProjects={allProjects}
          isOpen={settingsModalOpen}
          onClose={closeSettingsModal}
          onRefresh={() => refresh(false)}
          onDeleteProject={onDeleteProject}
          onWorkflowPathsMoved={onWorkflowPathsMoved}
        />
      ) : null}
      <RuntimeLibrariesModal
        isOpen={runtimeLibsOpen}
        onClose={() => setRuntimeLibsOpen(false)}
      />
      <RunRecordingsModal
        isOpen={runRecordingsOpen}
        onClose={() => setRunRecordingsOpen(false)}
        onOpenRecording={onOpenRecording}
      />
      <WorkflowProjectDownloadModal
        isOpen={projectModalProject != null}
        project={projectModalProject}
        actionLabel={projectModalMode === 'download' ? 'Download' : 'Duplicate'}
        activeVersion={projectModalActiveVersion}
        onClose={closeProjectModal}
        onSelectPublished={handleProjectModalSelectPublished}
        onSelectUnpublishedChanges={handleProjectModalSelectUnpublishedChanges}
      />
    </>
  );
};
