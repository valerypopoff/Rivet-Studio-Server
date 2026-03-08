import { type FC, useEffect, useRef } from 'react';
import { useOpenWorkflowProject } from './useOpenWorkflowProject';
import { getError } from '@ironclad/rivet-core';
import { toast } from 'react-toastify';
import { useLoadProject } from '../../../rivet/packages/app/src/hooks/useLoadProject';
import { useSaveProject } from '../../../rivet/packages/app/src/hooks/useSaveProject';
import { useAtom, useAtomValue } from 'jotai';
import {
  loadedProjectState,
  type OpenedProjectInfo,
  projectsState,
  openedProjectsState,
  projectState,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import type { WorkflowProjectPathMove } from './types';

const isWindowsPlatform = typeof navigator !== 'undefined' && /Win/.test(navigator.platform ?? '');
const SAVE_SHORTCUT_DEBUG_PREFIX = '[hosted-save-shortcut][iframe]';

export const EditorMessageBridge: FC = () => {
  const openProject = useOpenWorkflowProject();
  const loadProject = useLoadProject();
  const { saveProject } = useSaveProject();
  const [projects, setProjects] = useAtom(projectsState);
  const [openedProjects, setOpenedProjects] = useAtom(openedProjectsState);
  const [loadedProject, setLoadedProject] = useAtom(loadedProjectState);
  const currentProject = useAtomValue(projectState);
  const openedProjectIds = projects.openedProjectsSortedIds;
  const openProjectRef = useRef(openProject);
  const loadProjectRef = useRef(loadProject);
  const saveProjectRef = useRef(saveProject);
  openProjectRef.current = openProject;
  loadProjectRef.current = loadProject;
  saveProjectRef.current = saveProject;

  const saveCurrentProject = async () => {
    await saveProjectRef.current();

    if (loadedProject.path) {
      window.parent.postMessage({ type: 'project-saved', path: loadedProject.path }, '*');
    }
  };

  useEffect(() => {
    window.parent.postMessage({ type: 'editor-ready' }, '*');
  }, []);

  useEffect(() => {
    const handler = async (event: KeyboardEvent) => {
      const isSaveShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's';
      if (!isSaveShortcut) {
        return;
      }

      console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} observed keydown`, {
        isWindowsPlatform,
        defaultPrevented: event.defaultPrevented,
        repeat: event.repeat,
        targetTag: (event.target as HTMLElement | null)?.tagName ?? null,
        activeElementTag: document.activeElement?.tagName ?? null,
        loadedProjectPath: loadedProject.path,
      });

      event.preventDefault();
      event.stopPropagation();

      console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} prevented browser default`, {
        isWindowsPlatform,
        loadedProjectPath: loadedProject.path,
      });

      if (!isWindowsPlatform) {
        console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} calling hosted saveProject directly from iframe`);
        await saveCurrentProject();
      } else {
        console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} waiting for wrapper-managed Windows keyup save handling`);
      }
    };

    document.addEventListener('keydown', handler, true);
    return () => {
      document.removeEventListener('keydown', handler, true);
    };
  }, [loadedProject.path]);

  useEffect(() => {
    if (!isWindowsPlatform) {
      return;
    }

    const handler = async (event: KeyboardEvent) => {
      const isSaveShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's';
      if (!isSaveShortcut) {
        return;
      }

      console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} observed Windows keyup`, {
        defaultPrevented: event.defaultPrevented,
        repeat: event.repeat,
        targetTag: (event.target as HTMLElement | null)?.tagName ?? null,
        activeElementTag: document.activeElement?.tagName ?? null,
        loadedProjectPath: loadedProject.path,
      });

      event.preventDefault();
      event.stopPropagation();

      console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} calling hosted saveProject from Windows keyup handler`);
      await saveCurrentProject();
    };

    window.addEventListener('keyup', handler, true);
    return () => {
      window.removeEventListener('keyup', handler, true);
    };
  }, [loadedProject.path]);

  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      if (event.data?.type === 'save-project') {
        console.log(`${SAVE_SHORTCUT_DEBUG_PREFIX} received save-project message from parent`, {
          loadedProjectPath: loadedProject.path,
          openedProjectCount: openedProjectIds.length,
        });
        await saveCurrentProject();
        return;
      }

      if (event.data?.type === 'delete-workflow-project' && typeof event.data.path === 'string') {
        const deletedPath = event.data.path;
        const deletedProjectId = openedProjectIds.find((projectId) => openedProjects[projectId]?.fsPath === deletedPath);

        if (!deletedProjectId) {
          if (loadedProject.path === deletedPath) {
            setLoadedProject({ loaded: false, path: '' });
          }
          return;
        }

        const deletedProjectIndex = openedProjectIds.indexOf(deletedProjectId);
        const nextOpenedProjectIds = openedProjectIds.filter((projectId) => projectId !== deletedProjectId);
        const remainingProjects = Object.fromEntries(
          Object.entries(openedProjects).filter(([projectId]) => projectId !== deletedProjectId),
        ) as Record<string, OpenedProjectInfo>;

        setProjects({
          openedProjects: remainingProjects,
          openedProjectsSortedIds: nextOpenedProjectIds,
        });

        if (nextOpenedProjectIds.length === 0) {
          setLoadedProject({ loaded: false, path: '' });
          return;
        }

        const fallbackProjectId = nextOpenedProjectIds[deletedProjectIndex] ?? nextOpenedProjectIds[deletedProjectIndex - 1];

        if (deletedProjectId === currentProject.metadata.id && fallbackProjectId && remainingProjects[fallbackProjectId]) {
          await loadProjectRef.current(remainingProjects[fallbackProjectId]!);
        } else if (loadedProject.path === deletedPath) {
          setLoadedProject({
            loaded: true,
            path: remainingProjects[fallbackProjectId!]?.fsPath ?? '',
          });
        }

        return;
      }

      if (event.data?.type === 'workflow-paths-moved' && Array.isArray(event.data.moves)) {
        const moves: WorkflowProjectPathMove[] = event.data.moves.filter(
          (move: WorkflowProjectPathMove) =>
            move && typeof move.fromAbsolutePath === 'string' && typeof move.toAbsolutePath === 'string',
        );

        if (moves.length === 0) {
          return;
        }

        const moveMap = new Map(moves.map((move) => [move.fromAbsolutePath, move.toAbsolutePath]));
        const openedProjectsRecord = openedProjects as Record<string, OpenedProjectInfo>;
        const nextOpenedProjects = Object.fromEntries(
          Object.entries(openedProjectsRecord).map(([projectId, projectInfo]) => [
            projectId,
            projectInfo.fsPath && moveMap.has(projectInfo.fsPath)
              ? {
                  ...projectInfo,
                  fsPath: moveMap.get(projectInfo.fsPath)!,
                }
              : projectInfo,
          ]),
        ) as Record<string, OpenedProjectInfo>;

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
  }, [currentProject.metadata.id, loadedProject, openedProjectIds, openedProjects, setLoadedProject, setProjects]);

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
