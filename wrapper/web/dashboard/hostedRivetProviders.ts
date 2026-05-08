import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { ProviderOverrides } from '../../../rivet/packages/app/src/host';
import { HostedDatasetProvider } from '../io/HostedDatasetProvider';
import { HostedIOProvider } from '../io/HostedIOProvider';
import {
  getDefaultEnvironmentProvider,
  getDefaultPathPolicyProvider,
} from '../overrides/utils/tauri';

const hostedDatasetProvider = new HostedDatasetProvider();

export function clearHostedDatasetsForProject(projectId: ProjectId): Promise<void> {
  return hostedDatasetProvider.deleteStoredDatasetsForProject(projectId);
}

export const hostedRivetProviders = {
  io: new HostedIOProvider(hostedDatasetProvider),
  datasets: hostedDatasetProvider,
  environment: getDefaultEnvironmentProvider(),
  pathPolicy: getDefaultPathPolicyProvider(),
} satisfies ProviderOverrides;
