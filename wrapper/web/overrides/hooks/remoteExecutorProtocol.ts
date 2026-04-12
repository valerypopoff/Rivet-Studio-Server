import type { ProcessEvents } from '@ironclad/rivet-core';
import {
  rejectRemoteExecutionSession,
  resolveRemoteExecutionSession,
} from './remoteExecutionSession';

export type RemoteExecutionHandlerAdapter = {
  onAbort(data: ProcessEvents['abort']): void;
  onDone(data: ProcessEvents['done']): void;
  onError(data: ProcessEvents['error']): void;
  onGraphAbort(data: ProcessEvents['graphAbort']): void;
  onGraphFinish(data: ProcessEvents['graphFinish']): void;
  onGraphStart(data: ProcessEvents['graphStart']): void;
  onNodeError(data: ProcessEvents['nodeError']): void;
  onNodeExcluded(data: ProcessEvents['nodeExcluded']): void;
  onNodeFinish(data: ProcessEvents['nodeFinish']): void;
  onNodeOutputsCleared(data: ProcessEvents['nodeOutputsCleared']): void;
  onNodeStart(data: ProcessEvents['nodeStart']): void;
  onPartialOutput(data: ProcessEvents['partialOutput']): void;
  onPause(): void;
  onResume(): void;
  onStart(data: ProcessEvents['start']): void;
  onUserInput(data: ProcessEvents['userInput']): void;
};

export function logRemoteTrace(data: unknown): void {
  if (typeof data === 'object' && data !== null && 'message' in data) {
    const traceData = data as { level?: 'log' | 'info' | 'warn' | 'error' | 'debug'; message: unknown };
    const tracePrefix = traceData.level === 'error' ? 'sidecar stderr' : 'sidecar stdout';
    const traceMessage = String(traceData.message);

    switch (traceData.level) {
      case 'error':
        console.error(tracePrefix, traceMessage);
        break;
      case 'warn':
        console.warn(tracePrefix, traceMessage);
        break;
      case 'info':
        console.info(tracePrefix, traceMessage);
        break;
      case 'debug':
        console.debug(tracePrefix, traceMessage);
        break;
      default:
        console.log(tracePrefix, traceMessage);
        break;
    }

    return;
  }

  console.log('sidecar stdout', data);
}

export function createRemoteExecutorMessageHandler(
  currentExecution: RemoteExecutionHandlerAdapter,
): (message: string, data: unknown) => void {
  const simpleMessageHandlers: Partial<Record<string, (data: unknown) => void>> = {
    nodeStart: (data) => currentExecution.onNodeStart(data as ProcessEvents['nodeStart']),
    nodeFinish: (data) => currentExecution.onNodeFinish(data as ProcessEvents['nodeFinish']),
    nodeError: (data) => currentExecution.onNodeError(data as ProcessEvents['nodeError']),
    userInput: (data) => currentExecution.onUserInput(data as ProcessEvents['userInput']),
    start: (data) => currentExecution.onStart(data as ProcessEvents['start']),
    graphAbort: (data) => currentExecution.onGraphAbort(data as ProcessEvents['graphAbort']),
    partialOutput: (data) => currentExecution.onPartialOutput(data as ProcessEvents['partialOutput']),
    graphStart: (data) => currentExecution.onGraphStart(data as ProcessEvents['graphStart']),
    graphFinish: (data) => currentExecution.onGraphFinish(data as ProcessEvents['graphFinish']),
    nodeOutputsCleared: (data) => currentExecution.onNodeOutputsCleared(data as ProcessEvents['nodeOutputsCleared']),
    nodeExcluded: (data) => currentExecution.onNodeExcluded(data as ProcessEvents['nodeExcluded']),
  };

  return (message, data) => {
    const simpleHandler = simpleMessageHandlers[message];
    if (simpleHandler) {
      simpleHandler(data);
      return;
    }

    switch (message) {
      case 'done': {
        const doneData = data as ProcessEvents['done'];
        resolveRemoteExecutionSession(doneData.results);
        currentExecution.onDone(doneData);
        break;
      }
      case 'abort':
        rejectRemoteExecutionSession(new Error('graph execution aborted'));
        currentExecution.onAbort(data as ProcessEvents['abort']);
        break;
      case 'trace':
        logRemoteTrace(data);
        break;
      case 'pause':
        currentExecution.onPause();
        break;
      case 'resume':
        currentExecution.onResume();
        break;
      case 'error': {
        const errorData = data as ProcessEvents['error'];
        rejectRemoteExecutionSession(errorData.error);
        currentExecution.onError(errorData);
        break;
      }
      default:
        console.warn('Unhandled remote debugger message', message, data);
    }
  };
}
