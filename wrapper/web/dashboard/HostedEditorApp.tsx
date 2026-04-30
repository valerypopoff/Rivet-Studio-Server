import { type FC } from 'react';
import { RivetAppHost } from '../../../rivet/packages/app/src/host';
import { EditorMessageBridge } from './EditorMessageBridge';
import { RIVET_EXECUTOR_WS_URL } from '../../shared/hosted-env';

export const HostedEditorApp: FC = () => {
  return (
    <RivetAppHost executor={{ internalExecutorUrl: RIVET_EXECUTOR_WS_URL }}>
      <EditorMessageBridge />
    </RivetAppHost>
  );
};
