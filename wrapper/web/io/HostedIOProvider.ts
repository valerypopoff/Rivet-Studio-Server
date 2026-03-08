// HostedIOProvider: API-backed IOProvider for hosted mode
// Supports server-side path-based save/load alongside browser FSA API fallbacks

import {
  type NodeGraph,
  type Project,
  ExecutionRecorder,
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
import { apiReadText, apiWriteText, apiReadBinary } from '../../shared/api';
import { loadedProjectState } from '../../../rivet/packages/app/src/state/savedGraphs.js';

const API = RIVET_API_BASE_URL;
const jotaiStore = getDefaultStore();

async function apiListProjects(): Promise<string[]> {
  const resp = await fetch(`${API}/projects/list`);
  if (!resp.ok) throw new Error(`Failed to list projects: ${resp.statusText}`);
  const data = await resp.json();
  return data.files;
}

function getSuggestedProjectPath(defaultName: string): string {
  const loadedProject = jotaiStore.get(loadedProjectState) as {
    loaded: boolean;
    path: string | null;
  };
  const currentPath = loadedProject.path?.trim();

  if (!currentPath) {
    return `/workflows/${defaultName}`;
  }

  const lastSeparatorIndex = Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\'));
  if (lastSeparatorIndex === -1) {
    return defaultName;
  }

  const directory = currentPath.slice(0, lastSeparatorIndex + 1);
  return `${directory}${defaultName}`;
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
    const filePath = prompt('Save project to server path:', getSuggestedProjectPath(defaultName));

    if (!filePath) return undefined;

    const data = serializeProject(project, {
      trivet: serializeTrivetData(testData),
    }) as string;

    await apiWriteText(filePath, data);

    // Save datasets alongside
    const { saveDatasetsFile } = await import('../overrides/io/datasets.js');
    await saveDatasetsFile(filePath, project);

    return filePath;
  }

  async saveProjectDataNoPrompt(project: Project, testData: TrivetData, path: string): Promise<void> {
    const data = serializeProject(project, {
      trivet: serializeTrivetData(testData),
    }) as string;

    await apiWriteText(path, data);

    const { saveDatasetsFile } = await import('../overrides/io/datasets.js');
    await saveDatasetsFile(path, project);
  }

  async loadGraphData(callback: (graphData: NodeGraph) => void): Promise<void> {
    if ('showOpenFilePicker' in window) {
      try {
        const [fileHandle] = await (window as any).showOpenFilePicker({
          types: [{ description: 'Rivet Graph', accept: { 'application/octet-stream': ['.rivet-graph'] } }],
        });
        const file = await fileHandle.getFile();
        const text = await file.text();
        callback(deserializeGraph(text));
        return;
      } catch {
        return;
      }
    }
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
    const data = await apiReadText(path);
    const [projectData, attachedData] = deserializeProject(data, path);

    const trivetData = attachedData.trivet
      ? deserializeTrivetData(attachedData.trivet as SerializedTrivetData)
      : { testSuites: [] };

    const { loadDatasetsFile } = await import('../overrides/io/datasets.js');
    await loadDatasetsFile(path, projectData);

    return { project: projectData, testData: trivetData };
  }

  async loadRecordingData(callback: (data: { recorder: ExecutionRecorder; path: string }) => void): Promise<void> {
    if ('showOpenFilePicker' in window) {
      try {
        const [fileHandle] = await (window as any).showOpenFilePicker({
          types: [{ description: 'Rivet Recording', accept: { 'application/octet-stream': ['.rivet-recording'] } }],
        });
        const file = await fileHandle.getFile();
        const text = await file.text();
        callback({ recorder: ExecutionRecorder.deserializeFromString(text), path: fileHandle.name });
        return;
      } catch {
        return;
      }
    }
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
  }

  async readPathAsString(path: string): Promise<string> {
    return apiReadText(path);
  }

  async readPathAsBinary(path: string): Promise<Uint8Array> {
    return apiReadBinary(path);
  }
}
