import { type ProviderOverrides } from '../../../rivet/packages/app/src/host';
import { datasetProvider } from '../../../rivet/packages/app/src/utils/globals/datasetProvider';
import { HostedIOProvider } from '../io/HostedIOProvider';
import {
  getDefaultEnvironmentProvider,
  getDefaultPathPolicyProvider,
} from '../overrides/utils/tauri';

export const hostedRivetProviders = {
  io: new HostedIOProvider(),
  datasets: datasetProvider,
  environment: getDefaultEnvironmentProvider(),
  pathPolicy: getDefaultPathPolicyProvider(),
} satisfies ProviderOverrides;
