import { type ProviderOverrides } from '../../../rivet/packages/app/src/host';
import { BrowserDatasetProvider } from '../../../rivet/packages/app/src/io/BrowserDatasetProvider';
import { HostedIOProvider } from '../io/HostedIOProvider';
import {
  getDefaultEnvironmentProvider,
  getDefaultPathPolicyProvider,
} from '../overrides/utils/tauri';

const hostedDatasetProvider = new BrowserDatasetProvider();

export const hostedRivetProviders = {
  io: new HostedIOProvider(hostedDatasetProvider),
  datasets: hostedDatasetProvider,
  environment: getDefaultEnvironmentProvider(),
  pathPolicy: getDefaultPathPolicyProvider(),
} satisfies ProviderOverrides;
