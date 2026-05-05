import { type FC, useCallback } from 'react';
import {
  RivetAppHost,
  type RivetAppHostOpenErrorEvent,
  type RivetAppHostProjectSavedEvent,
} from '../../../rivet/packages/app/src/host';
import { EditorMessageBridge } from './EditorMessageBridge';
import { RIVET_EXECUTOR_WS_URL } from '../../shared/hosted-env';
import { postMessageToDashboard } from '../../shared/editor-bridge';
import { hostedRivetProviders } from './hostedRivetProviders';
import { useReconcileHostedProjectTitleAfterSave } from './useReconcileHostedProjectTitleAfterSave';

export const HostedEditorApp: FC = () => {
  const reconcileHostedProjectTitleAfterSave = useReconcileHostedProjectTitleAfterSave();

  const handleProjectSaved = useCallback((event: RivetAppHostProjectSavedEvent) => {
    reconcileHostedProjectTitleAfterSave(event);

    if (!event.path) {
      return;
    }

    postMessageToDashboard({ type: 'project-saved', path: event.path });
  }, [reconcileHostedProjectTitleAfterSave]);

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
