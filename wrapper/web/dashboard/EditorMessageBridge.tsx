import { type FC, useEffect, useRef } from 'react';
import { useOpenWorkflowProject } from './useOpenWorkflowProject';
import { ExecutionRecorder, getError } from '@valerypopoff/rivet2-core';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  loadedProjectState,
  type OpenedProjectsInfo,
  projectsState,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import { loadedRecordingState } from '../../../rivet/packages/app/src/state/execution';
import { defaultExecutorState } from '../../../rivet/packages/app/src/state/settings';
import { useRivetWorkspaceHost } from '../../../rivet/packages/app/src/host';
import type { WorkflowProjectPathMove } from './types';
import {
  isDashboardToEditorCommand,
  isValidBridgeOrigin,
  postMessageToDashboard,
} from '../../shared/editor-bridge';
import { getWorkflowRecordingVirtualProjectPath } from '../../shared/workflow-recording-types';
import { fetchWorkflowRecordingArtifactText } from './workflowApi';
import { clearOpenedProjectSession, remapOpenedProjectSessionPaths } from '../io/openedProjectSessionCache';
import { clearHostedProjectRevisionPath, remapHostedProjectRevisionPaths } from '../io/HostedIOProvider';
import { useSaveProject } from '../../../rivet/packages/app/src/hooks/useSaveProject';
import {
  focusHostedEditorCanvas,
  focusHostedEditorFrame,
  isSaveShortcutEvent,
} from './editorBridgeFocus';

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
  const workspace = useRivetWorkspaceHost();
  const openProject = useOpenWorkflowProject();
  const { saveProject } = useSaveProject();
  const projects = useAtomValue(projectsState);
  const loadedProject = useAtomValue(loadedProjectState);
  const setLoadedProject = useSetAtom(loadedProjectState);
  const setLoadedRecording = useSetAtom(loadedRecordingState);
  const setDefaultExecutor = useSetAtom(defaultExecutorState);
  const projectsRef = useRef<OpenedProjectsInfo>(projects);
  const loadedProjectRef = useRef(loadedProject);
  const workspaceRef = useRef(workspace);
  const openProjectRef = useRef(openProject);
  const saveProjectRef = useRef(saveProject);
  projectsRef.current = projects;
  loadedProjectRef.current = loadedProject;
  workspaceRef.current = workspace;
  openProjectRef.current = openProject;
  saveProjectRef.current = saveProject;

  const saveCurrentProject = async () => {
    await saveProjectRef.current();
  };

  useEffect(() => {
    postMessageToDashboard({ type: 'editor-ready' });
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

      if (!event.target.closest('.node-canvas')) {
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
          const latestProjects = projectsRef.current;
          const openedProjects = latestProjects.openedProjects;
          const openedProjectIds = latestProjects.openedProjectsSortedIds.filter((projectId) => openedProjects[projectId] != null);
          const deletedProjectId = openedProjectIds.find((projectId) => openedProjects[projectId]?.fsPath === deletedPath);
          clearHostedProjectRevisionPath(deletedPath);

          if (!deletedProjectId) {
            if (loadedProjectRef.current.path === deletedPath) {
              setLoadedProject({ loaded: false, path: '' });
            }
            break;
          }

          const closed = await workspaceRef.current.closeProject(deletedProjectId);
          if (closed) {
            clearOpenedProjectSession(deletedProjectId);
          }

          break;
        }

        case 'workflow-paths-moved': {
          const moves: WorkflowProjectPathMove[] = event.data.moves;
          if (moves.length === 0) {
            break;
          }

          remapOpenedProjectSessionPaths(moves);
          remapHostedProjectRevisionPaths(moves);
          workspaceRef.current.moveProjectPaths(
            moves.map((move) => ({
              from: move.fromAbsolutePath,
              to: move.toAbsolutePath,
            })),
          );

          break;
        }

        case 'open-project': {
          try {
            const opened = await openProjectRef.current(event.data.path, { replaceCurrent: Boolean(event.data.replaceCurrent) });
            if (!opened) {
              break;
            }

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

            const opened = await openProjectRef.current(virtualProjectPath, {
              replaceCurrent: Boolean(event.data.replaceCurrent),
              preferredGraphId,
            });
            if (!opened) {
              break;
            }

            setDefaultExecutor('browser');
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
    setLoadedProject,
    setLoadedRecording,
    setDefaultExecutor,
  ]);

  return null;
};
