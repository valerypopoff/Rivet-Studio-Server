// Re-export upstream datasetProvider — no override needed, just needs to be resolvable
import { BrowserDatasetProvider } from '../../../../../rivet/packages/app/src/io/BrowserDatasetProvider';

const datasetProvider = new BrowserDatasetProvider();

export { datasetProvider };
