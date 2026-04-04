import { type FC, useEffect, useRef } from 'react';
import { useOpenWorkflowProject } from './useOpenWorkflowProject';
import { ExecutionRecorder, getError } from '@ironclad/rivet-core';
import { useLoadProject } from '../../../rivet/packages/app/src/hooks/useLoadProject';
import { useSaveProject } from '../../../rivet/packages/app/src/hooks/useSaveProject';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  loadedProjectState,
  type OpenedProjectInfo,
  projectsState,
  openedProjectsState,
  projectState,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import { loadedRecordingState, selectedExecutorState } from '../../../rivet/packages/app/src/state/execution';
import type { WorkflowProjectPathMove } from './types';
import {
  isDashboardToEditorCommand,
  isValidBridgeOrigin,
  postMessageToDashboard,
} from '../../shared/editor-bridge';
import { getWorkflowRecordingVirtualProjectPath } from '../../shared/workflow-recording-types';
import { fetchWorkflowRecordingArtifactText } from './workflowApi';

const isSaveShortcutEvent = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  (event.code === 'KeyS' || event.key.toLowerCase() === 's');

const EDITOR_CANVAS_SELECTOR = '.node-canvas';
const CANVAS_FOCUS_PRESERVE_SELECTOR = 'input, textarea, select, button, [contenteditable="true"], [contenteditable=""], [role="textbox"]';

const focusElement = (element: HTMLElement | HTMLIFrameElement | null) => {
  if (!element) {
    return;
  }

  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
};

const focusHostedEditorFrame = () => {
  const frameElement = window.frameElement;

  if (!(frameElement instanceof HTMLIFrameElement)) {
    return;
  }

  focusElement(frameElement);
};

const isEditableElement = (element: Element | null | undefined): element is HTMLElement => {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  return ['input', 'textarea', 'select'].includes(element.tagName.toLowerCase());
};

const shouldPreserveCanvasFocusTarget = (target: Element) =>
  target.closest(CANVAS_FOCUS_PRESERVE_SELECTOR) !== null || (target instanceof HTMLElement && target.isContentEditable);

const focusHostedEditorCanvas = (target: Element) => {
  const canvasElement = target.closest(EDITOR_CANVAS_SELECTOR);

  if (!(canvasElement instanceof HTMLElement) || shouldPreserveCanvasFocusTarget(target)) {
    return;
  }

  const activeElement = document.activeElement;
  if (isEditableElement(activeElement)) {
    activeElement.blur();
  }

  canvasElement.tabIndex = -1;
  focusElement(canvasElement);
};

function getRecordingStartGraphId(recorder: ExecutionRecorder): string | undefined {
  for (const event of recorder.events) {
    if (event.type === 'start') {
      return event.data.startGraph;
    }

    if (event.type === 'graphStart') {
      return event.data.graphId;
    }
  }

  return undefined;
}

export const EditorMessageBridge: FC = () => {
  const openProject = useOpenWorkflowProject();
  const loadProject = useLoadProject();
  const { saveProject } = useSaveProject();
  const [projects, setProjects] = useAtom(projectsState);
  const [openedProjects, setOpenedProjects] = useAtom(openedProjectsState);
  const [loadedProject, setLoadedProject] = useAtom(loadedProjectState);
  const currentProject = useAtomValue(projectState);
  const setLoadedRecording = useSetAtom(loadedRecordingState);
  const setSelectedExecutor = useSetAtom(selectedExecutorState);
  const openedProjectIds = projects.openedProjectsSortedIds;
  const openProjectRef = useRef(openProject);
  const loadProjectRef = useRef(loadProject);
  const saveProjectRef = useRef(saveProject);
  openProjectRef.current = openProject;
  loadProjectRef.current = loadProject;
  saveProjectRef.current = saveProject;

  const saveCurrentProject = async () => {
    await saveProjectRef.current();
  };

  useEffect(() => {
    postMessageToDashboard({ type: 'editor-ready' });
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<{ path?: string }>;
      const savedPath = customEvent.detail?.path;

      if (!savedPath) {
        return;
      }

      postMessageToDashboard({ type: 'project-saved', path: savedPath });
    };

    window.addEventListener('rivet-project-saved', handler as EventListener);
    return () => {
      window.removeEventListener('rivet-project-saved', handler as EventListener);
    };
  }, []);

  useEffect(() => {
    const handler = async (event: KeyboardEvent) => {
      if (!isSaveShortcutEvent(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      await saveCurrentProject();
    };

    window.addEventListener('keydown', handler, true);
    document.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      document.removeEventListener('keydown', handler, true);
    };
  }, []);

  useEffect(() => {
    const handler = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      if (!event.target.closest(EDITOR_CANVAS_SELECTOR)) {
        return;
      }

      focusHostedEditorFrame();
      focusHostedEditorCanvas(event.target);
    };

    document.addEventListener('pointerdown', handler, true);
    return () => {
      document.removeEventListener('pointerdown', handler, true);
    };
  }, []);

  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      if (!isValidBridgeOrigin(event, window.parent)) {
        return;
      }

      if (!isDashboardToEditorCommand(event.data)) {
        return;
      }

      switch (event.data.type) {
        case 'save-project': {
          await saveCurrentProject();
          break;
        }

        case 'delete-workflow-project': {
          const deletedPath = event.data.path;
          const deletedProjectId = openedProjectIds.find((projectId) => openedProjects[projectId]?.fsPath === deletedPath);

          if (!deletedProjectId) {
            if (loadedProject.path === deletedPath) {
              setLoadedProject({ loaded: false, path: '' });
            }
            break;
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
            break;
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

          break;
        }

        case 'workflow-paths-moved': {
          const moves: WorkflowProjectPathMove[] = event.data.moves;
          if (moves.length === 0) {
            break;
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

          break;
        }

        case 'open-project': {
          try {
            await openProjectRef.current(event.data.path, { replaceCurrent: Boolean(event.data.replaceCurrent) });
            setLoadedRecording(null);
            focusHostedEditorFrame();
            postMessageToDashboard({ type: 'project-opened', path: event.data.path });
          } catch (error) {
            const message = getError(error).message;
            console.error('Failed to open workflow project:', error);
            postMessageToDashboard({ type: 'project-open-failed', path: event.data.path, error: message });
          }

          break;
        }

        case 'open-recording': {
          try {
            const serializedRecording = await fetchWorkflowRecordingArtifactText(event.data.recordingId, 'recording');
            const recorder = ExecutionRecorder.deserializeFromString(serializedRecording);
            const preferredGraphId = getRecordingStartGraphId(recorder);
            const virtualProjectPath = getWorkflowRecordingVirtualProjectPath(event.data.recordingId);

            await openProjectRef.current(virtualProjectPath, {
              replaceCurrent: Boolean(event.data.replaceCurrent),
              preferredGraphId,
            });
            setSelectedExecutor('browser');
            setLoadedRecording(null);

            setLoadedRecording({
              path: `${event.data.recordingId}.rivet-recording`,
              recorder,
            });

            focusHostedEditorFrame();
            postMessageToDashboard({ type: 'project-opened', path: virtualProjectPath });
          } catch (error) {
            const message = getError(error).message;
            console.error('Failed to open workflow recording:', error);
            postMessageToDashboard({ type: 'project-open-failed', path: event.data.recordingId, error: message });
          }

          break;
        }
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [
    currentProject.metadata.id,
    loadedProject,
    openedProjectIds,
    openedProjects,
    setLoadedProject,
    setLoadedRecording,
    setProjects,
    setSelectedExecutor,
  ]);

  useEffect(() => {
    const activeProjectInfo = openedProjects[currentProject.metadata.id];
    const activeProjectPath = openedProjectIds.length > 0 ? activeProjectInfo?.fsPath ?? '' : '';

    postMessageToDashboard({
      type: 'active-project-path-changed',
      path: activeProjectPath,
    });
  }, [currentProject.metadata.id, openedProjectIds, openedProjects]);

  useEffect(() => {
    postMessageToDashboard({
      type: 'open-project-count-changed',
      count: openedProjectIds.length,
    });
  }, [openedProjectIds.length]);

  return null;
};
