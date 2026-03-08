import { type FC, useEffect, useRef } from 'react';
import { useOpenWorkflowProject } from './useOpenWorkflowProject';
import { getError } from '@ironclad/rivet-core';
import { toast } from 'react-toastify';
import { useSaveProject } from '../../../rivet/packages/app/src/hooks/useSaveProject';
import { useAtom, useAtomValue } from 'jotai';
import {
  loadedProjectState,
  openedProjectsSortedIdsState,
  openedProjectsState,
  projectState,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import type { WorkflowProjectPathMove } from './types';

const isWindowsPlatform = typeof navigator !== 'undefined' && navigator.userAgent.includes('Win64');

export const EditorMessageBridge: FC = () => {
  const openProject = useOpenWorkflowProject();
  const { saveProject } = useSaveProject();
  const openedProjectIds = useAtomValue(openedProjectsSortedIdsState);
  const [openedProjects, setOpenedProjects] = useAtom(openedProjectsState);
  const [loadedProject, setLoadedProject] = useAtom(loadedProjectState);
  const currentProject = useAtomValue(projectState);
  const openProjectRef = useRef(openProject);
  const saveProjectRef = useRef(saveProject);
  openProjectRef.current = openProject;
  saveProjectRef.current = saveProject;

  useEffect(() => {
    window.parent.postMessage({ type: 'editor-ready' }, '*');
  }, []);

  useEffect(() => {
    const handler = async (event: KeyboardEvent) => {
      const isSaveShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's';
      if (!isSaveShortcut) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

       if (!isWindowsPlatform) {
        await saveProjectRef.current();
      }
    };

    document.addEventListener('keydown', handler, true);
    return () => {
      document.removeEventListener('keydown', handler, true);
    };
  }, []);

  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      if (event.data?.type === 'save-project') {
        await saveProjectRef.current();
        return;
      }

      if (event.data?.type === 'workflow-paths-moved' && Array.isArray(event.data.moves)) {
        const moves = event.data.moves.filter(
          (move: WorkflowProjectPathMove) =>
            move && typeof move.fromAbsolutePath === 'string' && typeof move.toAbsolutePath === 'string',
        );

        if (moves.length === 0) {
          return;
        }

        const moveMap = new Map(moves.map((move) => [move.fromAbsolutePath, move.toAbsolutePath]));
        const nextOpenedProjects = Object.fromEntries(
          Object.entries(openedProjects).map(([projectId, projectInfo]) => [
            projectId,
            projectInfo.fsPath && moveMap.has(projectInfo.fsPath)
              ? {
                  ...projectInfo,
                  fsPath: moveMap.get(projectInfo.fsPath)!,
                }
              : projectInfo,
          ]),
        );

        setOpenedProjects(nextOpenedProjects);

        if (loadedProject.path && moveMap.has(loadedProject.path)) {
          setLoadedProject({
            ...loadedProject,
            path: moveMap.get(loadedProject.path)!,
          });
        }

        return;
      }

      if (event.data?.type !== 'open-project' || typeof event.data.path !== 'string') return;

      try {
        await openProjectRef.current(event.data.path, { replaceCurrent: Boolean(event.data.replaceCurrent) });
        window.parent.postMessage({ type: 'project-opened', path: event.data.path }, '*');
      } catch (error) {
        const message = getError(error).message;
        console.error('Failed to open workflow project:', error);
        toast.error(`Failed to open project: ${message}`);
        window.parent.postMessage({ type: 'project-open-failed', path: event.data.path, error: message }, '*');
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [loadedProject, openedProjects, setLoadedProject, setOpenedProjects]);

  useEffect(() => {
    const activeProjectInfo = openedProjects[currentProject.metadata.id];
    const activeProjectPath = openedProjectIds.length > 0 ? activeProjectInfo?.fsPath ?? '' : '';

    window.parent.postMessage(
      {
        type: 'active-project-path-changed',
        path: activeProjectPath,
      },
      '*',
    );
  }, [currentProject.metadata.id, openedProjectIds, openedProjects]);

  useEffect(() => {
    window.parent.postMessage(
      {
        type: 'open-project-count-changed',
        count: openedProjectIds.length,
      },
      '*',
    );
  }, [openedProjectIds.length]);

  return null;
};
