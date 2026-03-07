import { type FC, useEffect, useRef } from 'react';
import { useOpenWorkflowProject } from './useOpenWorkflowProject';
import { getError } from '@ironclad/rivet-core';
import { toast } from 'react-toastify';
import { useSaveProject } from '../../../rivet/packages/app/src/hooks/useSaveProject';
import { useAtomValue } from 'jotai';
import {
  openedProjectsSortedIdsState,
  openedProjectsState,
  projectState,
} from '../../../rivet/packages/app/src/state/savedGraphs';

export const EditorMessageBridge: FC = () => {
  const openProject = useOpenWorkflowProject();
  const { saveProject } = useSaveProject();
  const openedProjectIds = useAtomValue(openedProjectsSortedIdsState);
  const openedProjects = useAtomValue(openedProjectsState);
  const currentProject = useAtomValue(projectState);
  const openProjectRef = useRef(openProject);
  const saveProjectRef = useRef(saveProject);
  openProjectRef.current = openProject;
  saveProjectRef.current = saveProject;

  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      if (event.data?.type === 'save-project') {
        await saveProjectRef.current();
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
  }, []);

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
