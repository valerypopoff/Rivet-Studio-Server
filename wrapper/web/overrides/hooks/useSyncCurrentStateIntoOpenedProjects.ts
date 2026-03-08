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

  // Clear the file-backed loaded path when the last opened project tab is gone.
  // This keeps scratch-project state from still looking file-backed after everything closes.
  useEffect(() => {
    if (openedProjectsSortedIds.length === 0 && loadedProject.path) {
      setLoadedProject({ loaded: false, path: '' });
    }
  }, [loadedProject.path, openedProjectsSortedIds.length, setLoadedProject]);

  // Ensure the active project exists in the opened-project registry, picks up its file path,
  // and appears in the tab order as soon as it becomes current.
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

  // Keep the current project's stored project object synchronized with editor edits.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- syncing only on currentProject changes avoids extra re-syncs from openedProjects mutations.
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

  // Track the latest edited graph for the current project so it can be written back if the
  // user switches tabs before a broader project-state sync happens.
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

  // When the active project changes, flush the previously active project's last in-memory
  // project/graph state into the opened-project registry before tracking the new one.
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
