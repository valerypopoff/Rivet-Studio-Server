import { useAtom, useSetAtom } from 'jotai';
import {
  loadedProjectState,
  projectsState,
  type OpenedProjectInfo,
  type OpenedProjectsInfo,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import { useLoadProject } from '../../../rivet/packages/app/src/hooks/useLoadProject';
import { ioProvider } from '../../../rivet/packages/app/src/utils/globals';
import { toast } from 'react-toastify';
import type { NodeGraph } from '@ironclad/rivet-core';

export function useOpenWorkflowProject() {
  const loadProject = useLoadProject();
  const [loadedProject] = useAtom(loadedProjectState);
  const [projects, setProjects] = useAtom(projectsState);

  return async (filePath: string) => {
    const isSwitchingProjects = Boolean(loadedProject.path) && loadedProject.path !== filePath;
    const isLeavingUnsavedScratchProject = !loadedProject.path && Object.keys(projects.openedProjects).length > 0;

    if (isSwitchingProjects || isLeavingUnsavedScratchProject) {
      const shouldContinue = window.confirm(
        'Switch projects? Unsaved edits in the current editor may be lost if you have not saved them yet.',
      );

      if (!shouldContinue) {
        return;
      }
    }

    const openedProjects = Object.values(projects.openedProjects) as OpenedProjectInfo[];

    const alreadyOpenByPath = openedProjects.find((projectInfo) => projectInfo.fsPath === filePath);

    if (alreadyOpenByPath) {
      await loadProject(alreadyOpenByPath);
      return;
    }

    const { project } = await ioProvider.loadProjectDataNoPrompt(filePath);

    const conflictingProject = openedProjects.find((projectInfo) => projectInfo.project.metadata.id === project.metadata.id);

    if (conflictingProject) {
      toast.error(
        `"${conflictingProject.project.metadata.title} [${conflictingProject.fsPath?.split('/').pop() ?? 'no path'}]" shares the same ID (${project.metadata.id}) and is already open. Please close that project first.`,
      );
      return;
    }

    const projectGraphs = Object.values(project.graphs) as NodeGraph[];

    const openedGraph =
      project.metadata.mainGraphId && project.graphs[project.metadata.mainGraphId]
        ? project.metadata.mainGraphId
        : projectGraphs
            .sort((a, b) => (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? ''))[0]?.metadata?.id;

    const projectInfo: OpenedProjectInfo = {
      project,
      fsPath: filePath,
      openedGraph,
    };

    setProjects((prev: OpenedProjectsInfo) => ({
      openedProjects: {
        ...prev.openedProjects,
        [project.metadata.id]: projectInfo,
      },
      openedProjectsSortedIds: prev.openedProjectsSortedIds.includes(project.metadata.id)
        ? prev.openedProjectsSortedIds
        : [...prev.openedProjectsSortedIds, project.metadata.id],
    }));

    await loadProject(projectInfo);
  };
}
