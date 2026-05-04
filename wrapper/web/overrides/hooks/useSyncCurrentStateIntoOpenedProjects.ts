import { useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import { graphState } from '../../../../rivet/packages/app/src/state/graph';
import {
  loadedProjectState,
  type OpenedProjectInfo,
  openedProjectSnapshotsState,
  openedProjectsState,
  openedProjectsSortedIdsState,
  projectDataState,
  projectState,
  projectsState,
} from '../../../../rivet/packages/app/src/state/savedGraphs';
import { trivetState } from '../../../../rivet/packages/app/src/state/trivet';
import { addOpenedProject } from '../../../../rivet/packages/app/src/utils/openedProjects.js';
import { resolveHostedProjectTitle, withHostedProjectTitle } from '../../dashboard/openedProjectMetadata';
import { primeOpenedProjectSession, syncOpenedProjectSessionIds } from '../../io/openedProjectSessionCache';

type LegacyOpenedProjectInfo = Partial<OpenedProjectInfo> & {
  project?: (Omit<Project, 'data'> & { data?: Project['data'] }) | null;
};

export function useSyncCurrentStateIntoOpenedProjects() {
  const setProjects = useSetAtom(projectsState);
  const setLoadedProject = useSetAtom(loadedProjectState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);

  const currentProject = useAtomValue(projectState);
  const currentProjectData = useAtomValue(projectDataState);
  const loadedProject = useAtomValue(loadedProjectState);
  const currentGraph = useAtomValue(graphState);
  const currentTrivetState = useAtomValue(trivetState);
  const openedProjects = useAtomValue(openedProjectsState);
  const openedProjectIds = useAtomValue(openedProjectsSortedIdsState);
  const currentProjectWithData = useMemo(
    () => ({
      ...currentProject,
      data: currentProjectData,
    }),
    [currentProject, currentProjectData],
  );
  const previousOpenedProjectIdsRef = useRef<ProjectId[]>([]);
  const suppressedClosedProjectIdsRef = useRef<Set<ProjectId>>(new Set());

  useEffect(() => {
    syncOpenedProjectSessionIds(openedProjectIds);
  }, [openedProjectIds]);

  useEffect(() => {
    setProjects((previousProjects) => {
      let changed = false;
      const nextOpenedProjects: Record<ProjectId, OpenedProjectInfo> = {};
      const nextOpenedProjectIds: ProjectId[] = [];

      for (const previousProjectId of previousProjects.openedProjectsSortedIds) {
        const entry = previousProjects.openedProjects[previousProjectId] as LegacyOpenedProjectInfo | undefined;
        if (!entry) {
          changed = true;
          continue;
        }

        const legacyProject = entry.project ?? null;
        const projectId = (entry.projectId ?? legacyProject?.metadata?.id ?? previousProjectId) as ProjectId;
        const fsPath = entry.fsPath ?? null;
        const title = resolveHostedProjectTitle(
          {
            metadata: {
              ...legacyProject?.metadata,
              title: entry.title ?? legacyProject?.metadata?.title,
            },
          } as Pick<Project, 'metadata'>,
          fsPath,
        );
        const openedGraph = entry.openedGraph ?? legacyProject?.metadata?.mainGraphId;

        nextOpenedProjects[projectId] = {
          projectId,
          title,
          fsPath,
          ...(openedGraph ? { openedGraph: openedGraph as GraphId } : {}),
        };
        nextOpenedProjectIds.push(projectId);

        if (
          projectId !== previousProjectId ||
          entry.projectId !== projectId ||
          entry.title !== title ||
          entry.fsPath !== fsPath ||
          entry.openedGraph !== openedGraph ||
          'project' in entry
        ) {
          changed = true;
        }
      }

      if (!changed) {
        changed = Object.keys(previousProjects.openedProjects).length !== nextOpenedProjectIds.length;
      }

      if (!changed) {
        return previousProjects;
      }

      return {
        openedProjects: nextOpenedProjects,
        openedProjectsSortedIds: nextOpenedProjectIds,
      };
    });
  }, [setProjects]);

  useEffect(() => {
    setOpenedProjectSnapshots((previousSnapshots) => {
      let changed = false;
      const nextSnapshots = { ...previousSnapshots };
      const openProjectIdSet = new Set(openedProjectIds);

      for (const entry of Object.values(openedProjects) as LegacyOpenedProjectInfo[]) {
        const legacyProject = entry.project ?? null;
        const projectId = (entry.projectId ?? legacyProject?.metadata?.id) as ProjectId | undefined;
        if (!legacyProject || !projectId || nextSnapshots[projectId]) {
          continue;
        }

        nextSnapshots[projectId] = {
          project: withHostedProjectTitle(legacyProject, entry.fsPath),
          data: legacyProject.data,
        };
        changed = true;
      }

      for (const projectId of Object.keys(nextSnapshots) as ProjectId[]) {
        if (!openProjectIdSet.has(projectId)) {
          delete nextSnapshots[projectId];
          changed = true;
        }
      }

      return changed ? nextSnapshots : previousSnapshots;
    });
  }, [openedProjectIds, openedProjects, setOpenedProjectSnapshots]);

  useEffect(() => {
    const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
    const previousOpenedProjectIds = previousOpenedProjectIdsRef.current;

    if (
      currentProjectId &&
      previousOpenedProjectIds.includes(currentProjectId) &&
      !openedProjectIds.includes(currentProjectId)
    ) {
      suppressedClosedProjectIdsRef.current.add(currentProjectId);
    }

    for (const openedProjectId of openedProjectIds) {
      suppressedClosedProjectIdsRef.current.delete(openedProjectId);
    }

    previousOpenedProjectIdsRef.current = openedProjectIds;
  }, [currentProject.metadata.id, openedProjectIds]);

  // Clear the file-backed loaded path when the last opened project tab is gone.
  // This keeps scratch-project state from still looking file-backed after everything closes.
  useEffect(() => {
    if (openedProjectIds.length === 0 && loadedProject.path) {
      setLoadedProject({ loaded: false, path: '' });
    }
  }, [loadedProject.path, openedProjectIds.length, setLoadedProject]);

  // Ensure the active project exists in the opened-project registry unless the user just closed
  // that active tab. Rivet 2.0 keeps full project content in openedProjectSnapshotsState; this
  // registry is lightweight tab metadata only.
  useEffect(() => {
    const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
    if (!currentProjectId || suppressedClosedProjectIdsRef.current.has(currentProjectId)) {
      return;
    }

    if (openedProjectIds.length > 0 && !openedProjectIds.includes(currentProjectId)) {
      return;
    }

    setProjects((previousProjects) => {
      const existingProject = previousProjects.openedProjects[currentProjectId];
      const nextOpenedGraph = currentGraph?.metadata?.id;
      const nextFsPath = loadedProject.path ?? existingProject?.fsPath ?? null;
      const projectForTab = withHostedProjectTitle(currentProjectWithData, nextFsPath);
      const nextTitle = resolveHostedProjectTitle(projectForTab, nextFsPath);
      const nextProjects = addOpenedProject(previousProjects, projectForTab, {
        ...(loadedProject.path ? { fsPath: loadedProject.path } : {}),
        ...(nextOpenedGraph ? { openedGraph: nextOpenedGraph } : {}),
      });
      const nextProject = nextProjects.openedProjects[currentProjectId];

      if (
        existingProject?.title === nextTitle &&
        existingProject?.fsPath === nextFsPath &&
        existingProject?.openedGraph === nextOpenedGraph &&
        previousProjects.openedProjectsSortedIds.includes(currentProjectId)
      ) {
        return previousProjects;
      }

      return nextProject ? nextProjects : previousProjects;
    });
  }, [currentGraph?.metadata?.id, currentProject, currentProjectWithData, loadedProject.path, setProjects]);

  useEffect(() => {
    const currentProjectId = currentProject.metadata.id as ProjectId | undefined;
    if (!currentProjectId || !openedProjectIds.includes(currentProjectId)) {
      return;
    }

    const expectedProjectPath = openedProjects[currentProjectId]?.fsPath ?? null;
    const loadedProjectPath = loadedProject.path ?? null;

    if (expectedProjectPath && loadedProjectPath && expectedProjectPath !== loadedProjectPath) {
      return;
    }

    primeOpenedProjectSession(currentProjectId, {
      fsPath: expectedProjectPath ?? loadedProjectPath,
      testData: {
        testSuites: currentTrivetState.testSuites,
      },
    });
  }, [currentProject.metadata.id, currentTrivetState.testSuites, loadedProject.path, openedProjectIds, openedProjects]);
}
