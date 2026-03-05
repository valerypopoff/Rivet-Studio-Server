// Override for rivet/packages/app/src/io/datasets.ts
// Routes .rivet-data file operations through API backend instead of Tauri fs

import { type Project, deserializeDatasets, serializeDatasets } from '@ironclad/rivet-core';
import { datasetProvider } from '../utils/globals/datasetProvider.js';
import { RIVET_API_BASE_URL } from '../../../shared/hosted-env';

const API = RIVET_API_BASE_URL;

async function apiExists(path: string): Promise<boolean> {
  const resp = await fetch(`${API}/native/exists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) return false;
  const data = await resp.json();
  return data.exists;
}

async function apiReadText(path: string): Promise<string> {
  const resp = await fetch(`${API}/native/read-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) throw new Error(`Failed to read: ${resp.statusText}`);
  const data = await resp.json();
  return data.contents;
}

async function apiWriteText(path: string, contents: string): Promise<void> {
  const resp = await fetch(`${API}/native/write-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, contents }),
  });
  if (!resp.ok) throw new Error(`Failed to write: ${resp.statusText}`);
}

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
