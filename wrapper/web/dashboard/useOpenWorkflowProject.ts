import { useSetAtom, useStore } from 'jotai';
import {
  loadedProjectState,
  openedProjectSnapshotsState,
  projectState,
  projectsState,
  type OpenedProjectInfo,
  type OpenedProjectsInfo,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import { ioProvider } from '../../../rivet/packages/app/src/utils/globals';
import { toast } from 'react-toastify';
import type { GraphId, NodeGraph, ProjectId } from '@ironclad/rivet-core';
import { useLoadProject } from '../overrides/hooks/useLoadProject';
import { primeOpenedProjectSession } from '../io/openedProjectSessionCache';
import { resolveHostedProjectTitle, withHostedProjectTitle } from './openedProjectMetadata';

type OpenWorkflowProjectOptions = {
  replaceCurrent?: boolean;
  preferredGraphId?: GraphId;
};

function getActiveOpenedProjectIds(projects: OpenedProjectsInfo): ProjectId[] {
  return projects.openedProjectsSortedIds.filter((projectId) => projects.openedProjects[projectId] != null);
}

function getOpenedProjectsByIds(projects: OpenedProjectsInfo, projectIds: ProjectId[]): OpenedProjectInfo[] {
  return projectIds.map((projectId) => projects.openedProjects[projectId]!);
}

function retainOpenedProjectsById(projects: OpenedProjectsInfo, projectIds: ProjectId[]): OpenedProjectsInfo['openedProjects'] {
  return Object.fromEntries(
    projectIds.map((projectId) => [projectId, projects.openedProjects[projectId]!]),
  ) as OpenedProjectsInfo['openedProjects'];
}

function removeOpenedProject(projects: OpenedProjectsInfo, projectIdToRemove: ProjectId): OpenedProjectsInfo {
  const retainedOpenedProjectIds = projects.openedProjectsSortedIds.filter(
    (projectId) => projectId !== projectIdToRemove && projects.openedProjects[projectId] != null,
  );

  return {
    openedProjects: retainOpenedProjectsById(projects, retainedOpenedProjectIds),
    openedProjectsSortedIds: retainedOpenedProjectIds,
  };
}

export function useOpenWorkflowProject() {
  const store = useStore();
  const loadProject = useLoadProject();
  const setProjects = useSetAtom(projectsState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);

  return async (filePath: string, options?: OpenWorkflowProjectOptions) => {
    const replaceCurrent = options?.replaceCurrent ?? false;
    const preferredGraphId = options?.preferredGraphId;
    const latestLoadedProject = store.get(loadedProjectState);
    const latestCurrentProject = store.get(projectState);
    const latestProjects = store.get(projectsState);
    const latestOpenedProjectSnapshots = store.get(openedProjectSnapshotsState);
    const activeOpenedProjectIds = getActiveOpenedProjectIds(latestProjects);
    const activeOpenedProjects = getOpenedProjectsByIds(latestProjects, activeOpenedProjectIds);
    const resetOpenProjectState = activeOpenedProjectIds.length === 0;
    const isSwitchingProjects = replaceCurrent && Boolean(latestLoadedProject.path) && latestLoadedProject.path !== filePath;
    const isLeavingUnsavedScratchProject = replaceCurrent && !latestLoadedProject.path && activeOpenedProjectIds.length > 0;

    if (isSwitchingProjects || isLeavingUnsavedScratchProject) {
      const shouldContinue = window.confirm(
        'Switch projects? Unsaved edits in the current editor may be lost if you have not saved them yet.',
      );

      if (!shouldContinue) {
        return;
      }
    }

    const alreadyOpenByPath = activeOpenedProjects.find((projectInfo) => projectInfo.fsPath === filePath);

    if (alreadyOpenByPath) {
      const alreadyOpenProject = alreadyOpenByPath.projectId === latestCurrentProject.metadata.id
        ? latestCurrentProject
        : latestOpenedProjectSnapshots[alreadyOpenByPath.projectId]?.project;
      const preferredOpenedGraph = preferredGraphId && alreadyOpenProject?.graphs[preferredGraphId]
        ? preferredGraphId
        : alreadyOpenByPath.openedGraph;

      if (replaceCurrent && latestCurrentProject.metadata.id !== alreadyOpenByPath.projectId) {
        setProjects((prev: OpenedProjectsInfo) => removeOpenedProject(prev, latestCurrentProject.metadata.id));
        setOpenedProjectSnapshots((prev) => {
          const nextSnapshots = { ...prev };
          delete nextSnapshots[latestCurrentProject.metadata.id];
          return nextSnapshots;
        });
      }

      const activated = await loadProject({
        ...alreadyOpenByPath,
        openedGraph: preferredOpenedGraph,
      });
      if (!activated) {
        throw new Error(`Failed to activate "${alreadyOpenByPath.title}".`);
      }
      return;
    }

    const { project: loadedProject, testData } = await ioProvider.loadProjectDataNoPrompt(filePath);
    const project = withHostedProjectTitle(loadedProject, filePath);

    const conflictingProject = activeOpenedProjects.find((projectInfo) => projectInfo.projectId === project.metadata.id);

    if (conflictingProject) {
      toast.error(
        `"${conflictingProject.title} [${conflictingProject.fsPath?.split('/').pop() ?? 'no path'}]" shares the same ID (${project.metadata.id}) and is already open. Please close that project first.`,
      );
      return;
    }

    primeOpenedProjectSession(project.metadata.id, {
      fsPath: filePath,
      testData,
    });

    const projectGraphs = Object.values(project.graphs) as NodeGraph[];

    const openedGraph = preferredGraphId && project.graphs[preferredGraphId]
      ? preferredGraphId
      : project.metadata.mainGraphId && project.graphs[project.metadata.mainGraphId]
        ? project.metadata.mainGraphId
        : projectGraphs
            .sort((a, b) => (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? ''))[0]?.metadata?.id;

    const projectInfo = {
      projectId: project.metadata.id,
      title: resolveHostedProjectTitle(project, filePath),
      fsPath: filePath,
      openedGraph,
    } satisfies OpenedProjectInfo;
    const projectSnapshot = {
      project,
      data: project.data,
    };

    setOpenedProjectSnapshots((prev) => ({
      ...(resetOpenProjectState
        ? {}
        : replaceCurrent
        ? Object.fromEntries(
            Object.entries(prev).filter(([id]) => id !== latestCurrentProject.metadata.id),
          )
        : prev),
      [project.metadata.id]: projectSnapshot,
    }));

    setProjects((prev: OpenedProjectsInfo) => {
      const filteredSortedIds = resetOpenProjectState
        ? []
        : replaceCurrent
          ? prev.openedProjectsSortedIds.filter(
              (id) => id !== latestCurrentProject.metadata.id && prev.openedProjects[id] != null,
            )
          : prev.openedProjectsSortedIds.filter((id) => prev.openedProjects[id] != null);

      const nextSortedIds = filteredSortedIds.includes(project.metadata.id)
        ? filteredSortedIds
        : [...filteredSortedIds, project.metadata.id];

      return {
        openedProjects: {
          ...(resetOpenProjectState ? {} : retainOpenedProjectsById(prev, filteredSortedIds)),
          [project.metadata.id]: projectInfo,
        },
        openedProjectsSortedIds: nextSortedIds,
      };
    });

    const activated = await loadProject(projectInfo, projectSnapshot);
    if (!activated) {
      setProjects((prev: OpenedProjectsInfo) => removeOpenedProject(prev, project.metadata.id));
      setOpenedProjectSnapshots((prev) => {
        const nextSnapshots = { ...prev };
        delete nextSnapshots[project.metadata.id];
        return nextSnapshots;
      });
      throw new Error(`Failed to activate "${projectInfo.title}".`);
    }
  };
}
