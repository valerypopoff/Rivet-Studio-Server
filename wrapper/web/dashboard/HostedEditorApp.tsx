import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type FC } from 'react';
import useAsyncEffect from 'use-async-effect';
import { allInitializeStoreFns } from '../../../rivet/packages/app/src/state/storage';
import { RivetApp } from '../../../rivet/packages/app/src/components/RivetApp';
import { EditorMessageBridge } from './EditorMessageBridge';

const queryClient = new QueryClient();

const HostedEditorAppContent: FC = () => {
  const [isLoading, setIsLoading] = useState(true);

  useAsyncEffect(async () => {
    for (const initializeFn of allInitializeStoreFns) {
      await initializeFn();
    }

    setIsLoading(false);
  }, []);

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <>
      <RivetApp />
      <EditorMessageBridge />
    </>
  );
};

export const HostedEditorApp: FC = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <HostedEditorAppContent />
    </QueryClientProvider>
  );
};
