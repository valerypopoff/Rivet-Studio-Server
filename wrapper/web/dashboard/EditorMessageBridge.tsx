import { type FC, useEffect, useRef } from 'react';
import { useOpenWorkflowProject } from './useOpenWorkflowProject';

export const EditorMessageBridge: FC = () => {
  const openProject = useOpenWorkflowProject();
  const openProjectRef = useRef(openProject);
  openProjectRef.current = openProject;

  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      if (event.data?.type !== 'open-project' || typeof event.data.path !== 'string') return;

      try {
        await openProjectRef.current(event.data.path);
        window.parent.postMessage({ type: 'project-opened', path: event.data.path }, '*');
      } catch {
        // Project load was cancelled or failed — no message sent back
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return null;
};
