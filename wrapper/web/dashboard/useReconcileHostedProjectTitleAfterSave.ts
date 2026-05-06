import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { RivetAppHostProjectSavedEvent } from '../../../rivet/packages/app/src/host';
import {
  openedProjectSnapshotsState,
  projectState,
  projectsState,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import { flushHybridStorageGroup } from '../../../rivet/packages/app/src/state/storage';
import { resolveHostedProjectTitleFromPath } from './openedProjectMetadata';

export function useReconcileHostedProjectTitleAfterSave() {
  const setProject = useSetAtom(projectState);
  const setProjects = useSetAtom(projectsState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);

  return useCallback((event: RivetAppHostProjectSavedEvent) => {
    const projectId = event.project.metadata.id as ProjectId | undefined;
    const title = resolveHostedProjectTitleFromPath(event.path);
    if (!projectId || !title) {
      return;
    }

    setProject((previousProject) => {
      if (previousProject.metadata.id !== projectId || previousProject.metadata.title === title) {
        return previousProject;
      }

      return {
        ...previousProject,
        metadata: {
          ...previousProject.metadata,
          title,
        },
      };
    });

    setProjects((previousProjects) => {
      const openedProject = previousProjects.openedProjects[projectId];
      if (!openedProject) {
        return previousProjects;
      }

      const nextOpenedProject = {
        ...openedProject,
        title,
        fsPath: event.path ?? openedProject.fsPath,
      };

      if (
        openedProject.title === nextOpenedProject.title &&
        openedProject.fsPath === nextOpenedProject.fsPath
      ) {
        return previousProjects;
      }

      return {
        ...previousProjects,
        openedProjects: {
          ...previousProjects.openedProjects,
          [projectId]: nextOpenedProject,
        },
      };
    });

    setOpenedProjectSnapshots((previousSnapshots) => {
      const snapshot = previousSnapshots[projectId];
      if (!snapshot || snapshot.project.metadata.title === title) {
        return previousSnapshots;
      }

      return {
        ...previousSnapshots,
        [projectId]: {
          ...snapshot,
          project: {
            ...snapshot.project,
            metadata: {
              ...snapshot.project.metadata,
              title,
            },
          },
        },
      };
    });

    void flushHybridStorageGroup('project');
  }, [setOpenedProjectSnapshots, setProject, setProjects]);
}
