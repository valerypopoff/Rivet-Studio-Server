import '../../shims/install-process-shim';

self.addEventListener('message', (event) => {
  void handleMessage(event);
});

async function handleMessage(event: MessageEvent) {
  const { id, type, data } = event.data;

  if (type !== 'deserializeProject') {
    return;
  }

  try {
    const { deserializeProject } = await import('@ironclad/rivet-core');
    const [project] = deserializeProject(data);
    self.postMessage({ id, type: 'deserializeProject:result', result: project });
  } catch (error) {
    self.postMessage({ id, type: 'deserializeProject:result', error });
  }
}
