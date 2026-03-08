// Override for rivet/packages/app/src/io/datasets.ts
// Routes .rivet-data file operations through API backend instead of Tauri fs

import { type Project, deserializeDatasets, serializeDatasets } from '@ironclad/rivet-core';
import { datasetProvider } from '../utils/globals/datasetProvider.js';
import { apiExists, apiReadText, apiWriteText } from '../../../shared/api';

export async function saveDatasetsFile(projectFilePath: string, project: Project) {
  const dataPath = projectFilePath.replace('.rivet-project', '.rivet-data');
  const datasets = await datasetProvider.exportDatasetsForProject(project.metadata.id);

  if (datasets.length > 0 || (await apiExists(dataPath))) {
    const serializedDatasets = serializeDatasets(datasets);
    await apiWriteText(dataPath, serializedDatasets);
  }
}

export async function loadDatasetsFile(projectFilePath: string, project: Project) {
  const datasetsFilePath = projectFilePath.replace('.rivet-project', '.rivet-data');

  const datasetsFileExists = await apiExists(datasetsFilePath);

  if (!datasetsFileExists) {
    await datasetProvider.importDatasetsForProject(project.metadata.id, []);
    return;
  }

  const fileContents = await apiReadText(datasetsFilePath);
  const datasets = deserializeDatasets(fileContents);
  await datasetProvider.importDatasetsForProject(project.metadata.id, datasets);
}
