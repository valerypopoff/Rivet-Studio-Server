import { useAtom, useSetAtom } from 'jotai';
import {
  loadedProjectState,
  projectState,
  projectsState,
  type OpenedProjectInfo,
  type OpenedProjectsInfo,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import { useLoadProject } from '../../../rivet/packages/app/src/hooks/useLoadProject';
import { ioProvider } from '../../../rivet/packages/app/src/utils/globals';
import { toast } from 'react-toastify';
import type { GraphId, NodeGraph } from '@ironclad/rivet-core';

type OpenWorkflowProjectOptions = {
  replaceCurrent?: boolean;
  preferredGraphId?: GraphId;
};

export function useOpenWorkflowProject() {
  const loadProject = useLoadProject();
  const [loadedProject] = useAtom(loadedProjectState);
  const [currentProject] = useAtom(projectState);
  const [projects, setProjects] = useAtom(projectsState);

  return async (filePath: string, options?: OpenWorkflowProjectOptions) => {
    const replaceCurrent = options?.replaceCurrent ?? false;
    const preferredGraphId = options?.preferredGraphId;
    const isSwitchingProjects = replaceCurrent && Boolean(loadedProject.path) && loadedProject.path !== filePath;
    const isLeavingUnsavedScratchProject = replaceCurrent && !loadedProject.path && Object.keys(projects.openedProjects).length > 0;

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
      const preferredOpenedGraph = preferredGraphId && alreadyOpenByPath.project.graphs[preferredGraphId]
        ? preferredGraphId
        : alreadyOpenByPath.openedGraph;

      if (replaceCurrent && currentProject.metadata.id !== alreadyOpenByPath.project.metadata.id) {
        setProjects((prev: OpenedProjectsInfo) => {
          const nextOpenedProjects = { ...prev.openedProjects };
          delete nextOpenedProjects[currentProject.metadata.id];

          return {
            openedProjects: nextOpenedProjects,
            openedProjectsSortedIds: prev.openedProjectsSortedIds.filter((projectId) => projectId !== currentProject.metadata.id),
          };
        });
      }

      await loadProject({
        ...alreadyOpenByPath,
        openedGraph: preferredOpenedGraph,
      });
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

    const openedGraph = preferredGraphId && project.graphs[preferredGraphId]
      ? preferredGraphId
      : project.metadata.mainGraphId && project.graphs[project.metadata.mainGraphId]
        ? project.metadata.mainGraphId
        : projectGraphs
            .sort((a, b) => (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? ''))[0]?.metadata?.id;

    const projectInfo: OpenedProjectInfo = {
      project,
      fsPath: filePath,
      openedGraph,
    };

    setProjects((prev: OpenedProjectsInfo) => {
      const filteredSortedIds = replaceCurrent
        ? prev.openedProjectsSortedIds.filter((id) => id !== currentProject.metadata.id)
        : prev.openedProjectsSortedIds;

      const nextSortedIds = filteredSortedIds.includes(project.metadata.id)
        ? filteredSortedIds
        : [...filteredSortedIds, project.metadata.id];

      return {
        openedProjects: {
          ...(replaceCurrent
            ? Object.fromEntries(
                Object.entries(prev.openedProjects).filter(([id]) => id !== currentProject.metadata.id),
              )
            : prev.openedProjects),
          [project.metadata.id]: projectInfo,
        },
        openedProjectsSortedIds: nextSortedIds,
      };
    });

    await loadProject(projectInfo);
  };
}
