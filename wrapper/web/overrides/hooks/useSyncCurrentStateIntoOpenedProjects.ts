import { useEffect, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { graphState } from '../../../../rivet/packages/app/src/state/graph';
import {
  loadedProjectState,
  type OpenedProjectInfo,
  openedProjectsSortedIdsState,
  openedProjectsState,
  projectState,
} from '../../../../rivet/packages/app/src/state/savedGraphs';

export function useSyncCurrentStateIntoOpenedProjects() {
  const [openedProjects, setOpenedProjects] = useAtom(openedProjectsState);
  const [openedProjectsSortedIds, setOpenedProjectsSortedIds] = useAtom(openedProjectsSortedIdsState);
  const setLoadedProject = useSetAtom(loadedProjectState);

  const currentProject = useAtomValue(projectState);
  const loadedProject = useAtomValue(loadedProjectState);
  const currentGraph = useAtomValue(graphState);

  useEffect(() => {
    if (openedProjectsSortedIds.length === 0 && loadedProject.path) {
      setLoadedProject({ loaded: false, path: '' });
    }
  }, [loadedProject.path, openedProjectsSortedIds.length, setLoadedProject]);

  useEffect(() => {
    if (currentProject && openedProjects[currentProject.metadata.id] == null) {
      setOpenedProjects({
        ...openedProjects,
        [currentProject.metadata.id]: {
          project: currentProject,
          fsPath: null,
        } satisfies OpenedProjectInfo,
      });
    }

    if (loadedProject.path && !openedProjects[currentProject.metadata.id]?.fsPath) {
      setOpenedProjects({
        ...openedProjects,
        [currentProject.metadata.id]: {
          project: currentProject,
          fsPath: loadedProject.path,
        } satisfies OpenedProjectInfo,
      });
    }

    if (currentProject && openedProjectsSortedIds.includes(currentProject.metadata.id) === false) {
      setOpenedProjectsSortedIds([...openedProjectsSortedIds, currentProject.metadata.id]);
    }
  }, [currentProject, loadedProject, openedProjects, openedProjectsSortedIds, setOpenedProjects, setOpenedProjectsSortedIds]);

  useEffect(() => {
    setOpenedProjects({
      ...openedProjects,
      [currentProject.metadata.id]: {
        ...openedProjects[currentProject.metadata.id],
        project: currentProject,
      } satisfies OpenedProjectInfo,
    });
  }, [currentProject]);

  const [prevProjectState, setPrevProjectState] = useState({
    project: currentProject,
    openedGraph: currentGraph?.metadata?.id,
  } satisfies OpenedProjectInfo);

  useEffect(() => {
    if (
      currentGraph.metadata?.id != null &&
      currentProject.graphs[currentGraph.metadata.id] &&
      prevProjectState.project.metadata.id === currentProject.metadata.id
    ) {
      setPrevProjectState({
        project: {
          ...currentProject,
          graphs: {
            ...currentProject.graphs,
            [currentGraph.metadata!.id!]: currentGraph,
          },
        },
        openedGraph: currentGraph.metadata!.id!,
      } satisfies OpenedProjectInfo);
    }
  }, [currentGraph, currentProject, prevProjectState.project.metadata.id]);

  useEffect(() => {
    if (
      prevProjectState.project != null &&
      prevProjectState.project.metadata.id !== currentProject.metadata.id &&
      openedProjects[prevProjectState.project.metadata.id]
    ) {
      setOpenedProjects({
        ...openedProjects,
        [prevProjectState.project.metadata.id]: {
          ...openedProjects[prevProjectState.project.metadata.id],
          project: prevProjectState.project,
          openedGraph: prevProjectState.openedGraph,
        } satisfies OpenedProjectInfo,
      });
      setPrevProjectState({
        project: currentProject,
        openedGraph: currentGraph?.metadata?.id,
      } satisfies OpenedProjectInfo);
    }
  }, [currentProject]);
}
