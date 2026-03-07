import { type FC, useEffect, useRef } from 'react';
import { useOpenWorkflowProject } from './useOpenWorkflowProject';
import { getError } from '@ironclad/rivet-core';
import { toast } from 'react-toastify';

export const EditorMessageBridge: FC = () => {
  const openProject = useOpenWorkflowProject();
  const openProjectRef = useRef(openProject);
  openProjectRef.current = openProject;

  useEffect(() => {
    const handler = async (event: MessageEvent) => {
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

  return null;
};
