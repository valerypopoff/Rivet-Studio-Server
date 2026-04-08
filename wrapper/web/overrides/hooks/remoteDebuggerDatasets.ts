import { datasetProvider } from '../../../../rivet/packages/app/src/utils/globals/datasetProvider';

const datasetHandlers: Record<string, (payload: any) => Promise<unknown>> = {
  'datasets:get-metadata': (payload) => datasetProvider.getDatasetMetadata(payload.id),
  'datasets:get-for-project': (payload) => datasetProvider.getDatasetsForProject(payload.projectId),
  'datasets:get-data': (payload) => datasetProvider.getDatasetData(payload.id),
  'datasets:put-data': (payload) => datasetProvider.putDatasetData(payload.id, payload.data),
  'datasets:put-row': (payload) => datasetProvider.putDatasetRow(payload.id, payload.row),
  'datasets:put-metadata': (payload) => datasetProvider.putDatasetMetadata(payload.metadata),
  'datasets:clear-data': (payload) => datasetProvider.clearDatasetData(payload.id),
  'datasets:delete': (payload) => datasetProvider.deleteDataset(payload.id),
  'datasets:knn': (payload) => datasetProvider.knnDatasetRows(payload.datasetId, payload.k, payload.vector),
};

export async function handleRemoteDebuggerDatasetsMessage(
  type: string,
  data: any,
  socket: WebSocket,
): Promise<void> {
  const handler = datasetHandlers[type];
  if (!handler) {
    console.error(`Unknown datasets message type: ${type}`);
    return;
  }

  const { requestId, payload } = data;
  const result = await handler(payload);
  socket.send(JSON.stringify({
    type: 'datasets:response',
    data: { requestId, payload: result },
  }));
}
