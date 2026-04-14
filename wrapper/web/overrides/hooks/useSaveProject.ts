// Override for rivet/packages/app/src/hooks/useSaveProject.ts
// Keeps hosted save behavior in tracked wrapper code so prod image builds do not
// depend on local edits inside the ignored rivet/ tree.

import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { loadedProjectState, openedProjectsState, projectState } from '../../../../rivet/packages/app/src/state/savedGraphs.js';
import { useSaveCurrentGraph } from '../../../../rivet/packages/app/src/hooks/useSaveCurrentGraph.js';
import { produce } from 'immer';
import { toast, type Id as ToastId } from 'react-toastify';
import { ioProvider } from '../../../../rivet/packages/app/src/utils/globals.js';
import { trivetState } from '../../../../rivet/packages/app/src/state/trivet.js';
import { getWorkflowRecordingIdFromVirtualProjectPath } from '../../../shared/workflow-recording-types.js';

function dispatchProjectSaved(path: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent('rivet-project-saved', {
    detail: {
      path,
    },
  }));
}

function getSaveErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) {
    return `Failed to save project: ${cause.message}`;
  }

  return 'Failed to save project';
}

export function useSaveProject() {
  const saveGraph = useSaveCurrentGraph();
  const project = useAtomValue(projectState);
  const [loadedProject, setLoadedProject] = useAtom(loadedProjectState);
  const { testSuites } = useAtomValue(trivetState);
  const setOpenedProjects = useSetAtom(openedProjectsState);

  async function saveProject() {
    if (!loadedProject.loaded || !loadedProject.path) {
      return saveProjectAs();
    }

    if (getWorkflowRecordingIdFromVirtualProjectPath(loadedProject.path)) {
      toast.info('Recording replays are read-only. Use Save As to create a new project file.');
      return saveProjectAs();
    }

    const savedGraph = saveGraph();

    const newProject = savedGraph
      ? produce(project, (draft) => {
          draft.graphs[savedGraph.metadata!.id!] = savedGraph;
        })
      : project;

    // Large datasets can save slowly because of indexeddb, so show a "saving..." toast if it's a slow save
    let saving: ToastId | undefined;
    const savingTimeout = setTimeout(() => {
      saving = toast.info('Saving project');
    }, 500);

    try {
      await ioProvider.saveProjectDataNoPrompt(newProject, { testSuites }, loadedProject.path);

      if (saving != null) {
        toast.dismiss(saving);
      }
      clearTimeout(savingTimeout);

      toast.success('Project saved');
      setLoadedProject({
        loaded: true,
        path: loadedProject.path,
      });
      dispatchProjectSaved(loadedProject.path);
    } catch (cause) {
      clearTimeout(savingTimeout);
      toast.error(getSaveErrorMessage(cause));
    }
  }

  async function saveProjectAs() {
    const savedGraph = saveGraph();

    const newProject = savedGraph
      ? produce(project, (draft) => {
          draft.graphs[savedGraph.metadata!.id!] = savedGraph;
        })
      : project;

    // Large datasets can save slowly because of indexeddb, so show a "saving..." toast if it's a slow save
    let saving: ToastId | undefined;
    const savingTimeout = setTimeout(() => {
      saving = toast.info('Saving project');
    }, 500);

    try {
      const filePath = await ioProvider.saveProjectData(newProject, { testSuites });

      if (saving != null) {
        toast.dismiss(saving);
      }
      clearTimeout(savingTimeout);

      if (filePath) {
        toast.success('Project saved');
        setLoadedProject({
          loaded: true,
          path: filePath,
        });
        setOpenedProjects({
          [project.metadata.id]: {
            project,
            fsPath: filePath,
          },
        });
        dispatchProjectSaved(filePath);
      }
    } catch (cause) {
      clearTimeout(savingTimeout);
      toast.error(getSaveErrorMessage(cause));
    }
  }

  return {
    saveProject,
    saveProjectAs,
  };
}
