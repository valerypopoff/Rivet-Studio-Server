import type { WorkflowProjectPathMove } from './workflow-types';

export type DashboardToEditorCommand =
  | { type: 'open-project'; path: string; replaceCurrent: boolean }
  | { type: 'open-recording'; projectPath: string; recordingPath: string; replaceCurrent: boolean }
  | { type: 'save-project' }
  | { type: 'delete-workflow-project'; path: string }
  | { type: 'workflow-paths-moved'; moves: WorkflowProjectPathMove[] };

export type EditorToDashboardEvent =
  | { type: 'editor-ready' }
  | { type: 'project-opened'; path: string }
  | { type: 'project-open-failed'; path: string; error: string }
  | { type: 'active-project-path-changed'; path: string }
  | { type: 'open-project-count-changed'; count: number }
  | { type: 'project-saved'; path: string; didChangePersistedState: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object';

const getBridgeOrigin = (): string => {
  if (typeof window === 'undefined') {
    return '*';
  }

  const origin = window.location.origin;
  return origin && origin !== 'null' ? origin : '*';
};

const isWorkflowMove = (value: unknown): value is WorkflowProjectPathMove =>
  isRecord(value) &&
  typeof value.fromAbsolutePath === 'string' &&
  typeof value.toAbsolutePath === 'string';

export function isDashboardToEditorCommand(value: unknown): value is DashboardToEditorCommand {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'open-project':
      return typeof value.path === 'string' && typeof value.replaceCurrent === 'boolean';
    case 'open-recording':
      return typeof value.projectPath === 'string' &&
        typeof value.recordingPath === 'string' &&
        typeof value.replaceCurrent === 'boolean';
    case 'save-project':
      return true;
    case 'delete-workflow-project':
      return typeof value.path === 'string';
    case 'workflow-paths-moved':
      return Array.isArray(value.moves) && value.moves.every(isWorkflowMove);
    default:
      return false;
  }
}

export function isEditorToDashboardEvent(value: unknown): value is EditorToDashboardEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'editor-ready':
      return true;
    case 'project-opened':
    case 'active-project-path-changed':
      return typeof value.path === 'string';
    case 'project-saved':
      return typeof value.path === 'string' && typeof value.didChangePersistedState === 'boolean';
    case 'project-open-failed':
      return typeof value.path === 'string' && typeof value.error === 'string';
    case 'open-project-count-changed':
      return typeof value.count === 'number';
    default:
      return false;
  }
}

export function isValidBridgeOrigin(event: MessageEvent, expectedSource: MessageEventSource | null): boolean {
  if (event.source !== expectedSource) {
    return false;
  }

  const expectedOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  return !expectedOrigin || expectedOrigin === 'null' || event.origin === expectedOrigin;
}

export function postMessageToEditor(targetWindow: Window, command: DashboardToEditorCommand): void {
  targetWindow.postMessage(command, getBridgeOrigin());
}

export function postMessageToDashboard(event: EditorToDashboardEvent): void {
  window.parent.postMessage(event, getBridgeOrigin());
}
