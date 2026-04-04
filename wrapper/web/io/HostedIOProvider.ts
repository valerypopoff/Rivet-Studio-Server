// HostedIOProvider: API-backed IOProvider for hosted mode
// Supports server-side path-based save/load alongside browser FSA API fallbacks

import {
  type NodeGraph,
  type Project,
  ExecutionRecorder,
  deserializeDatasets,
  deserializeGraph,
  deserializeProject,
  serializeGraph,
  serializeProject,
} from '@ironclad/rivet-core';
import { type IOProvider } from '../../../rivet/packages/app/src/io/IOProvider.js';
import {
  type SerializedTrivetData,
  type TrivetData,
  deserializeTrivetData,
  serializeTrivetData,
} from '@ironclad/trivet';
import { getDefaultStore } from 'jotai';
import { RIVET_API_BASE_URL } from '../../shared/hosted-env';
import { apiReadBinary, apiReadText } from '../../shared/api';
import { MANAGED_WORKFLOW_VIRTUAL_ROOT } from '../../shared/workflow-types';
import { getWorkflowRecordingIdFromVirtualProjectPath } from '../../shared/workflow-recording-types';
import { loadedProjectState } from '../../../rivet/packages/app/src/state/savedGraphs.js';
import { datasetProvider } from '../../../rivet/packages/app/src/utils/globals/datasetProvider.js';
import { fetchWorkflowRecordingArtifactText } from '../dashboard/workflowApi';
import { getEnvVar } from '../overrides/utils/tauri';

const API = RIVET_API_BASE_URL;
const jotaiStore = getDefaultStore();
const projectRevisionIdByPath = new Map<string, string | null>();
let workflowStorageBackendPromise: Promise<'filesystem' | 'managed'> | null = null;

async function apiListProjects(): Promise<string[]> {
  const resp = await fetch(`${API}/projects/list`);
  if (!resp.ok) throw new Error(`Failed to list projects: ${resp.statusText}`);
  const data = await resp.json();
  return data.files;
}

async function apiLoadProject(path: string): Promise<{
  contents: string;
  datasetsContents: string | null;
  revisionId: string | null;
}> {
  const response = await fetch(`${API}/projects/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    throw new Error(`Failed to load project: ${response.statusText}`);
  }

  return response.json();
}

async function apiSaveProject(options: {
  path: string;
  contents: string;
  datasetsContents: string | null;
  expectedRevisionId: string | null;
}): Promise<{
  path: string;
  revisionId: string | null;
}> {
  const response = await fetch(`${API}/projects/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: response.statusText }));
    const error = new Error(data.error || response.statusText) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return response.json();
}

async function getWorkflowStorageBackend(): Promise<'filesystem' | 'managed'> {
  if (!workflowStorageBackendPromise) {
    workflowStorageBackendPromise = (async () => {
      const value =
        (await getEnvVar('RIVET_STORAGE_MODE'))?.trim().toLowerCase() ||
        (await getEnvVar('RIVET_STORAGE_BACKEND'))?.trim().toLowerCase() ||
        (await getEnvVar('RIVET_WORKFLOWS_STORAGE_BACKEND'))?.trim().toLowerCase();
      return value === 'managed' ? 'managed' : 'filesystem';
    })().catch((error) => {
      workflowStorageBackendPromise = null;
      throw error;
    });
  }

  return workflowStorageBackendPromise;
}

async function getSuggestedProjectPath(defaultName: string): Promise<string> {
  const loadedProject = jotaiStore.get(loadedProjectState) as {
    loaded: boolean;
    path: string | null;
  };
  const currentPath = loadedProject.path?.trim();

  if (!currentPath || getWorkflowRecordingIdFromVirtualProjectPath(currentPath)) {
    return (await getWorkflowStorageBackend()) === 'managed'
      ? `${MANAGED_WORKFLOW_VIRTUAL_ROOT}/${defaultName}`
      : `/workflows/${defaultName}`;
  }

  const lastSeparatorIndex = Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\'));
  if (lastSeparatorIndex === -1) {
    return defaultName;
  }

  const directory = currentPath.slice(0, lastSeparatorIndex + 1);
  return `${directory}${defaultName}`;
}

async function pickSingleFile(options: { accept?: string } = {}): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';

    if (options.accept) {
      input.accept = options.accept;
    }

    let settled = false;
    let focusTimerId: number | null = null;
    const finish = (file: File | null) => {
      if (settled) {
        return;
      }

      settled = true;
      if (focusTimerId != null) {
        window.clearTimeout(focusTimerId);
        focusTimerId = null;
      }
      window.removeEventListener('focus', handleWindowFocus, true);
      input.remove();
      resolve(file);
    };

    const handleWindowFocus = () => {
      focusTimerId = window.setTimeout(() => {
        finish(input.files?.[0] ?? null);
      }, 300);
    };

    input.addEventListener('change', () => {
      finish(input.files?.[0] ?? null);
    }, { once: true });
    window.addEventListener('focus', handleWindowFocus, true);
    document.body.appendChild(input);
    input.click();
  });
}

export class HostedIOProvider implements IOProvider {
  static isSupported(): boolean {
    return true;
  }

  async saveGraphData(graphData: NodeGraph): Promise<void> {
    // Use browser FSA API for graph export
    if ('showSaveFilePicker' in window) {
      try {
        const fileHandle = await (window as any).showSaveFilePicker({
          suggestedName: `${graphData.metadata?.name ?? 'graph'}.rivet-graph`,
        });
        const writable = await fileHandle.createWritable();
        await writable.write(serializeGraph(graphData) as string);
        await writable.close();
        return;
      } catch {
        // User cancelled
        return;
      }
    }
    // Fallback: download
    const data = serializeGraph(graphData) as string;
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${graphData.metadata?.name ?? 'graph'}.rivet-graph`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async saveProjectData(project: Project, testData: TrivetData): Promise<string | undefined> {
    // Show a simple prompt for server path
    const defaultName = `${project.metadata?.title ?? 'project'}.rivet-project`;
    const filePath = prompt('Save project to server path:', await getSuggestedProjectPath(defaultName));

    if (!filePath) return undefined;

    const data = serializeProject(project, {
      trivet: serializeTrivetData(testData),
    }) as string;
    const datasets = await datasetProvider.exportDatasetsForProject(project.metadata.id);
    const saved = await apiSaveProject({
      path: filePath,
      contents: data,
      datasetsContents: datasets.length > 0 ? serializeDatasets(datasets) : null,
      expectedRevisionId: projectRevisionIdByPath.get(filePath) ?? null,
    });

    projectRevisionIdByPath.delete(filePath);
    projectRevisionIdByPath.set(saved.path, saved.revisionId ?? null);
    return saved.path;
  }

  async saveProjectDataNoPrompt(project: Project, testData: TrivetData, path: string): Promise<void> {
    if (getWorkflowRecordingIdFromVirtualProjectPath(path)) {
      throw new Error('Recording replay projects are read-only. Use Save As to create a new project file.');
    }

    const data = serializeProject(project, {
      trivet: serializeTrivetData(testData),
    }) as string;
    const datasets = await datasetProvider.exportDatasetsForProject(project.metadata.id);
    const saved = await apiSaveProject({
      path,
      contents: data,
      datasetsContents: datasets.length > 0 ? serializeDatasets(datasets) : null,
      expectedRevisionId: projectRevisionIdByPath.get(path) ?? null,
    });

    projectRevisionIdByPath.set(saved.path, saved.revisionId ?? null);
  }

  async loadGraphData(callback: (graphData: NodeGraph) => void): Promise<void> {
    if ('showOpenFilePicker' in window) {
      try {
        // Chromium rejects custom extensions like ".rivet-graph" in picker type filters.
        const [fileHandle] = await (window as any).showOpenFilePicker();
        const file = await fileHandle.getFile();
        const text = await file.text();
        callback(deserializeGraph(text));
        return;
      } catch {
        return;
      }
    }

    const file = await pickSingleFile({ accept: '.rivet-graph' });
    if (!file) {
      return;
    }

    const text = await file.text();
    callback(deserializeGraph(text));
  }

  async loadProjectData(
    callback: (data: { project: Project; testData: TrivetData; path: string }) => void,
  ): Promise<void> {
    // Try to list known server projects first so users can pick from an index when possible.
    // This stays separate from the manual path prompt because fresh installs still need a
    // direct-entry fallback even when listing fails or returns no saved projects.
    try {
      const files = await apiListProjects();
      if (files.length > 0) {
        const selection = prompt(
          `Available projects on server:\n${files.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nEnter number or full path:`,
        );

        if (!selection) return;

        let path: string;
        const num = parseInt(selection, 10);
        if (!isNaN(num) && num >= 1 && num <= files.length) {
          path = files[num - 1]!;
        } else {
          path = selection;
        }

        const projectData = await this.loadProjectDataNoPrompt(path);
        callback({ ...projectData, path });
        return;
      }
    } catch {
      // Fall through to manual path entry if project listing is unavailable.
    }

    // Preserve the explicit manual-path prompt for empty servers and listing failures.
    const path = prompt('Enter server path to .rivet-project file:');
    if (!path) return;

    const projectData = await this.loadProjectDataNoPrompt(path);
    callback({ ...projectData, path });
  }

  async loadProjectDataNoPrompt(path: string): Promise<{ project: Project; testData: TrivetData }> {
    const recordingId = getWorkflowRecordingIdFromVirtualProjectPath(path);
    if (recordingId) {
      const data = await fetchWorkflowRecordingArtifactText(recordingId, 'replay-project');
      const [projectData, attachedData] = deserializeProject(data, path);

      const trivetData = attachedData.trivet
        ? deserializeTrivetData(attachedData.trivet as SerializedTrivetData)
        : { testSuites: [] };

      try {
        const datasetsText = await fetchWorkflowRecordingArtifactText(recordingId, 'replay-dataset');
        const datasets = deserializeDatasets(datasetsText);
        await datasetProvider.importDatasetsForProject(projectData.metadata.id, datasets);
      } catch (error) {
        const status = typeof error === 'object' &&
          error != null &&
          'status' in error &&
          typeof (error as { status?: unknown }).status === 'number'
          ? (error as { status: number }).status
          : undefined;

        if (status !== 404) {
          throw error;
        }

        await datasetProvider.importDatasetsForProject(projectData.metadata.id, []);
      }

      return { project: projectData, testData: trivetData };
    }

    const loaded = await apiLoadProject(path);
    projectRevisionIdByPath.set(path, loaded.revisionId ?? null);
    const data = loaded.contents;
    const [projectData, attachedData] = deserializeProject(data, path);

    const trivetData = attachedData.trivet
      ? deserializeTrivetData(attachedData.trivet as SerializedTrivetData)
      : { testSuites: [] };

    if (loaded.datasetsContents) {
      const datasets = deserializeDatasets(loaded.datasetsContents);
      await datasetProvider.importDatasetsForProject(projectData.metadata.id, datasets);
    } else {
      await datasetProvider.importDatasetsForProject(projectData.metadata.id, []);
    }

    return { project: projectData, testData: trivetData };
  }

  async loadRecordingData(callback: (data: { recorder: ExecutionRecorder; path: string }) => void): Promise<void> {
    if ('showOpenFilePicker' in window) {
      try {
        // Chromium rejects custom extensions like ".rivet-recording" in picker type filters.
        const [fileHandle] = await (window as any).showOpenFilePicker();
        const file = await fileHandle.getFile();
        const text = await file.text();
        callback({ recorder: ExecutionRecorder.deserializeFromString(text), path: fileHandle.name });
        return;
      } catch {
        return;
      }
    }

    const file = await pickSingleFile({ accept: '.rivet-recording' });
    if (!file) {
      return;
    }

    const text = await file.text();
    callback({ recorder: ExecutionRecorder.deserializeFromString(text), path: file.name });
  }

  async openDirectory(): Promise<string | string[] | null> {
    const path = prompt('Enter server directory path:');
    return path;
  }

  async openFilePath(): Promise<string> {
    const path = prompt('Enter server file path:');
    return path ?? '';
  }

  async saveString(content: string, defaultFileName: string): Promise<void> {
    if ('showSaveFilePicker' in window) {
      try {
        const fileHandle = await (window as any).showSaveFilePicker({ suggestedName: defaultFileName });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        return;
      } catch {
        // Fallback
      }
    }
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultFileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  async readFileAsString(callback: (data: string, fileName: string) => void): Promise<void> {
    if ('showOpenFilePicker' in window) {
      try {
        const [fileHandle] = await (window as any).showOpenFilePicker();
        const file = await fileHandle.getFile();
        const text = await file.text();
        callback(text, file.name);
        return;
      } catch {
        return;
      }
    }

    const file = await pickSingleFile();
    if (!file) {
      return;
    }

    const text = await file.text();
    callback(text, file.name);
  }

  async readFileAsBinary(callback: (data: Uint8Array, fileName: string) => void): Promise<void> {
    if ('showOpenFilePicker' in window) {
      try {
        const [fileHandle] = await (window as any).showOpenFilePicker();
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        callback(new Uint8Array(buffer), file.name);
        return;
      } catch {
        return;
      }
    }

    const file = await pickSingleFile();
    if (!file) {
      return;
    }

    const buffer = await file.arrayBuffer();
    callback(new Uint8Array(buffer), file.name);
  }

  async readPathAsString(path: string): Promise<string> {
    if (path.endsWith('.rivet-project')) {
      return (await apiLoadProject(path)).contents;
    }

    return apiReadText(path);
  }

  async readPathAsBinary(path: string): Promise<Uint8Array> {
    return apiReadBinary(path);
  }
}
