import { type FC, useCallback } from 'react';
import {
  RivetAppHost,
  type RivetAppHostOpenErrorEvent,
} from '../../../rivet/packages/app/src/host';
import { EditorMessageBridge } from './EditorMessageBridge';
import { RIVET_EXECUTOR_WS_URL } from '../../shared/hosted-env';
import { postMessageToDashboard } from '../../shared/editor-bridge';
import { hostedRivetProviders } from './hostedRivetProviders';

export const HostedEditorApp: FC = () => {
  const handleProjectSaved = useCallback((event: { path: string | null }) => {
    if (!event.path) {
      return;
    }

    postMessageToDashboard({ type: 'project-saved', path: event.path });
  }, []);

  const handleActiveProjectChanged = useCallback((event: { path: string | null }) => {
    postMessageToDashboard({
      type: 'active-project-path-changed',
      path: event.path ?? '',
    });
  }, []);

  const handleOpenProjectCountChanged = useCallback((event: { count: number }) => {
    postMessageToDashboard({
      type: 'open-project-count-changed',
      count: event.count,
    });
  }, []);

  const handleOpenError = useCallback((event: RivetAppHostOpenErrorEvent) => {
    console.error('Rivet host open operation failed:', event);
  }, []);

  return (
    <RivetAppHost
      executor={{ internalExecutorUrl: RIVET_EXECUTOR_WS_URL }}
      providers={hostedRivetProviders}
      onActiveProjectChanged={handleActiveProjectChanged}
      onOpenError={handleOpenError}
      onOpenProjectCountChanged={handleOpenProjectCountChanged}
      onProjectSaved={handleProjectSaved}
    >
      <EditorMessageBridge />
    </RivetAppHost>
  );
};
