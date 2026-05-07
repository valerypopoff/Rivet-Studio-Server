import { type FC, useCallback, useEffect, useRef } from 'react';
import { useOpenWorkflowProject } from './useOpenWorkflowProject';
import { getError, type ExecutionRecorder, type ProjectId } from '@valerypopoff/rivet2-core';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  loadedProjectState,
  type OpenedProjectsInfo,
  projectsState,
} from '../../../rivet/packages/app/src/state/savedGraphs';
import { deleteHostedProjectContextState } from '../overrides/state/savedGraphs';
import { loadedRecordingState } from '../../../rivet/packages/app/src/state/execution';
import { selectedExecutorState } from '../../../rivet/packages/app/src/state/settings';
import type { RivetWorkspaceHost } from '../../../rivet/packages/app/src/host';
import type { WorkflowProjectPathMove } from './types';
import {
  type DashboardToEditorCommand,
  isDashboardToEditorCommand,
  isValidBridgeOrigin,
  postMessageToDashboard,
} from '../../shared/editor-bridge';
import {
  getWorkflowRecordingIdFromVirtualProjectPath,
  getWorkflowRecordingVirtualProjectPath,
} from '../../shared/workflow-recording-types';
import { fetchWorkflowRecordingArtifactText } from './workflowApi';
import { clearOpenedProjectSession, remapOpenedProjectSessionPaths } from '../io/openedProjectSessionCache';
import { clearHostedProjectRevisionPath, remapHostedProjectRevisionPaths } from '../io/HostedIOProvider';
import { useSaveProject } from '../../../rivet/packages/app/src/hooks/useSaveProject';
import {
  focusHostedEditorCanvas,
  focusHostedEditorFrame,
  isSaveShortcutEvent,
} from './editorBridgeFocus';
import { clearHostedDatasetsForProject } from './hostedRivetProviders';

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

async function clearDeletedHostedProjectState(projectIds: Iterable<ProjectId>): Promise<void> {
  for (const projectId of projectIds) {
    deleteHostedProjectContextState(projectId);

    try {
      await clearHostedDatasetsForProject(projectId);
    } catch (error) {
      console.error('Failed to clear hosted datasets for deleted project:', error);
    }

    clearOpenedProjectSession(projectId);
  }
}

type LoadedWorkflowRecording = {
  path: string;
  recorder: ExecutionRecorder;
};

async function fetchLoadedWorkflowRecording(recordingId: string): Promise<LoadedWorkflowRecording> {
  const serializedRecording = await fetchWorkflowRecordingArtifactText(recordingId, 'recording');

  return {
    path: `${recordingId}.rivet-recording`,
    recorder: ExecutionRecorder.deserializeFromString(serializedRecording),
  };
}

type EditorMessageBridgeProps = {
  workspaceHost: RivetWorkspaceHost;
};

export const EditorMessageBridge: FC<EditorMessageBridgeProps> = ({ workspaceHost }) => {
  const openProject = useOpenWorkflowProject(workspaceHost);
  const { saveProject } = useSaveProject();
  const projects = useAtomValue(projectsState);
  const loadedProject = useAtomValue(loadedProjectState);
  const setLoadedProject = useSetAtom(loadedProjectState);
  const setLoadedRecording = useSetAtom(loadedRecordingState);
  const setSelectedExecutor = useSetAtom(selectedExecutorState);
  const projectsRef = useRef<OpenedProjectsInfo>(projects);
  const loadedProjectRef = useRef(loadedProject);
  const workspaceRef = useRef(workspaceHost);
  const openProjectRef = useRef(openProject);
  const saveProjectRef = useRef(saveProject);
  const openCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const recordingByProjectPathRef = useRef(new Map<string, LoadedWorkflowRecording>());
  projectsRef.current = projects;
  loadedProjectRef.current = loadedProject;
  workspaceRef.current = workspaceHost;
  openProjectRef.current = openProject;
  saveProjectRef.current = saveProject;

  const saveCurrentProject = async () => {
    await saveProjectRef.current();
  };

  const activateWorkflowRecording = useCallback((loadedRecording: LoadedWorkflowRecording) => {
    // Current Rivet routes run-button clicks through selectedExecutorState.
    // The default executor is only a startup preference, so replay must switch
    // the live executor to browser before the user clicks Play Recording.
    setSelectedExecutor('browser');
    setLoadedRecording(loadedRecording);
  }, [setLoadedRecording, setSelectedExecutor]);

  useEffect(() => {
    let cancelled = false;
    const projectPath = loadedProject.path;

    if (!projectPath) {
      setLoadedRecording(null);
      return;
    }

    const cachedRecording = recordingByProjectPathRef.current.get(projectPath);
    if (cachedRecording) {
      activateWorkflowRecording(cachedRecording);
      return;
    }

    const recordingId = getWorkflowRecordingIdFromVirtualProjectPath(projectPath);
    if (!recordingId) {
      setLoadedRecording(null);
      return;
    }

    setLoadedRecording(null);
    void fetchLoadedWorkflowRecording(recordingId)
      .then((loadedRecording) => {
        if (cancelled) {
          return;
        }

        recordingByProjectPathRef.current.set(projectPath, loadedRecording);
        activateWorkflowRecording(loadedRecording);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error('Failed to restore workflow recording:', error);
        setLoadedRecording(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activateWorkflowRecording, loadedProject.path, setLoadedRecording]);

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
    type OpenCommand = Extract<DashboardToEditorCommand, { type: 'open-project' | 'open-recording' }>;

    const runOpenCommand = async (command: OpenCommand): Promise<void> => {
      switch (command.type) {
        case 'open-project':
          try {
            const replacedPath = command.replaceCurrent ? loadedProjectRef.current.path : '';
            const opened = await openProjectRef.current(command.path, { replaceCurrent: Boolean(command.replaceCurrent) });
            if (!opened) {
              break;
            }

            if (replacedPath && replacedPath !== command.path) {
              recordingByProjectPathRef.current.delete(replacedPath);
            }
            setLoadedRecording(null);
            focusHostedEditorFrame();
            postMessageToDashboard({ type: 'project-opened', path: command.path });
          } catch (error) {
            const message = getError(error).message;
            console.error('Failed to open workflow project:', error);
            postMessageToDashboard({ type: 'project-open-failed', path: command.path, error: message });
          }

          break;

        case 'open-recording':
          try {
            const loadedRecording = await fetchLoadedWorkflowRecording(command.recordingId);
            const preferredGraphId = getRecordingStartGraphId(loadedRecording.recorder);
            const virtualProjectPath = getWorkflowRecordingVirtualProjectPath(command.recordingId);
            const replacedPath = command.replaceCurrent ? loadedProjectRef.current.path : '';

            recordingByProjectPathRef.current.set(virtualProjectPath, loadedRecording);
            const opened = await openProjectRef.current(virtualProjectPath, {
              replaceCurrent: Boolean(command.replaceCurrent),
              preferredGraphId,
            });
            if (!opened) {
              recordingByProjectPathRef.current.delete(virtualProjectPath);
              if (loadedProjectRef.current.path === virtualProjectPath) {
                setLoadedRecording(null);
              }
              break;
            }

            if (replacedPath && replacedPath !== virtualProjectPath) {
              recordingByProjectPathRef.current.delete(replacedPath);
            }
            activateWorkflowRecording(loadedRecording);

            focusHostedEditorFrame();
            postMessageToDashboard({ type: 'project-opened', path: virtualProjectPath });
          } catch (error) {
            const message = getError(error).message;
            console.error('Failed to open workflow recording:', error);
            postMessageToDashboard({ type: 'project-open-failed', path: command.recordingId, error: message });
          }

          break;
      }
    };

    const enqueueOpenCommand = (command: OpenCommand): void => {
      const queued = openCommandQueueRef.current
        .catch(() => undefined)
        .then(() => runOpenCommand(command));
      openCommandQueueRef.current = queued.catch((error) => {
        console.error('Failed to process hosted editor open command:', error);
      });
    };

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
          const deletedProjectIds = new Set<ProjectId>();
          if (event.data.projectId) {
            deletedProjectIds.add(event.data.projectId as ProjectId);
          }
          if (deletedProjectId) {
            deletedProjectIds.add(deletedProjectId);
          }
          clearHostedProjectRevisionPath(deletedPath);

          let closed = false;
          if (deletedProjectId) {
            try {
              closed = await workspaceRef.current.closeProject(deletedProjectId);
            } catch (error) {
              console.error('Failed to close deleted workflow project:', error);
            }
          }

          await clearDeletedHostedProjectState(deletedProjectIds);

          if (!closed && loadedProjectRef.current.path === deletedPath) {
            setLoadedProject({ loaded: false, path: '' });
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

        case 'open-project':
        case 'open-recording':
          enqueueOpenCommand(event.data);
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [
    setLoadedProject,
    activateWorkflowRecording,
    setLoadedRecording,
  ]);

  return null;
};
