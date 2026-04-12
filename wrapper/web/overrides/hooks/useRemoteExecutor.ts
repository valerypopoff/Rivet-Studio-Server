// Override for rivet/packages/app/src/hooks/useRemoteExecutor.ts
// Uses env-driven WebSocket URL in onDisconnect reconnect

import {
  type NodeId,
  type StringArrayDataValue,
  globalRivetNodeRegistry,
  type GraphId,
  type DataValue,
  GraphProcessor,
  type Outputs,
} from '@ironclad/rivet-core';
import { useCurrentExecution } from '../../../../rivet/packages/app/src/hooks/useCurrentExecution';
import { graphState } from '../../../../rivet/packages/app/src/state/graph';
import { settingsState } from '../state/settings';
import { setCurrentDebuggerMessageHandler, useRemoteDebugger, isExecutorConnected } from './useRemoteDebugger';
import { fillMissingSettingsFromEnvironmentVariables } from '../utils/tauri';
import { loadedProjectState, projectContextState, projectDataState, projectState } from '../../../../rivet/packages/app/src/state/savedGraphs';
import { useStableCallback } from '../../../../rivet/packages/app/src/hooks/useStableCallback';
import { toast } from 'react-toastify';
import { trivetState } from '../../../../rivet/packages/app/src/state/trivet';
import { runTrivet } from '@ironclad/trivet';
import { produce } from 'immer';
import { userInputModalQuestionsState, userInputModalSubmitState } from '../../../../rivet/packages/app/src/state/userInput';
import { entries } from '../../../../rivet/packages/core/src/utils/typeSafety';
import { type RunDataByNodeId, lastRunDataByNodeState } from '../../../../rivet/packages/app/src/state/dataFlow';
import { useAtomValue, useSetAtom, useAtom } from 'jotai';
import { useEffect } from 'react';
import { createRemoteExecutorMessageHandler } from './remoteExecutorProtocol';
import { beginRemoteExecutionSession } from './remoteExecutionSession';

export function useRemoteExecutor() {
  const project = useAtomValue(projectState);
  const projectData = useAtomValue(projectDataState);
  const projectContext = useAtomValue(projectContextState(project.metadata.id));

  const currentExecution = useCurrentExecution();
  const graph = useAtomValue(graphState);
  const savedSettings = useAtomValue(settingsState);
  const [{ testSuites }, setTrivetState] = useAtom(trivetState);
  const setUserInputModalSubmit = useSetAtom(userInputModalSubmitState);
  const setUserInputQuestions = useSetAtom(userInputModalQuestionsState);
  const lastRunData = useAtomValue(lastRunDataByNodeState);
  const loadedProject = useAtomValue(loadedProjectState);

  const remoteDebugger = useRemoteDebugger({
    onDisconnect: () => {
      currentExecution.onStop();
    },
  });

  async function uploadProjectToExecutor(projectToUpload: typeof project, options?: { includeStaticData?: boolean }) {
    const canUpload =
      remoteDebugger.remoteDebuggerState.isInternalExecutor ||
      remoteDebugger.remoteDebuggerState.remoteUploadAllowed;
    if (!canUpload) return;

    const includeStaticData = options?.includeStaticData ?? true;

    remoteDebugger.send('set-dynamic-data', {
      project: {
        ...projectToUpload,
        graphs: {
          ...projectToUpload.graphs,
          [graph.metadata!.id!]: graph,
        },
      },
      settings: await fillMissingSettingsFromEnvironmentVariables(
        savedSettings,
        globalRivetNodeRegistry.getPlugins(),
      ),
    });

    if (includeStaticData) {
      for (const [id, dataValue] of entries(projectData)) {
        remoteDebugger.sendRaw(`set-static-data:${id}:${dataValue}`);
      }
    }
  }

  function buildContextValues(): Record<string, DataValue> {
    return entries(projectContext).reduce(
      (acc, [id, value]) => ({ ...acc, [id]: (value as any).value }),
      {} as Record<string, DataValue>,
    );
  }

  useEffect(() => {
    setCurrentDebuggerMessageHandler(createRemoteExecutorMessageHandler(currentExecution));
    return () => {
      setCurrentDebuggerMessageHandler(null);
    };
  }, [currentExecution]);

  const tryRunGraph = async (options: { to?: NodeId[]; from?: NodeId; graphId?: GraphId } = {}) => {
    if (!isExecutorConnected()) {
      toast.warn('Not connected to executor — retrying automatically…');
      return;
    }

    setUserInputModalSubmit({
      submit: (nodeId: NodeId, answers: StringArrayDataValue) => {
        remoteDebugger.send('user-input', { nodeId, answers });

        // Remove from pending questions
        setUserInputQuestions((q) =>
          produce(q, (draft) => {
            delete draft[nodeId];
          }),
        );
      },
    });

    const graphToRun = options.graphId ?? graph.metadata!.id!;

    try {
      await uploadProjectToExecutor(project);

      const contextValues = buildContextValues();

      if (options.from) {
        // Use a local graph processor to get dependency nodes instead of asking the remote debugger
        const processor = new GraphProcessor(project, graph.metadata!.id!, undefined, true);
        const dependencyNodes = processor.getDependencyNodesDeep(options.from);
        const preloadData = getDependentDataForNodeForPreload(dependencyNodes, lastRunData);

        remoteDebugger.send('preload', { nodeData: preloadData });
      }

      remoteDebugger.send('run', {
        graphId: graphToRun,
        runToNodeIds: options.to,
        contextValues,
        runFromNodeId: options.from,
        projectPath: loadedProject.path,
      });
    } catch (e) {
      console.error(e);
    }
    return;
  };

  const tryRunTests = useStableCallback(
    async (options: { testSuiteIds?: string[]; testCaseIds?: string[]; iterationCount?: number } = {}) => {
      toast.info(
        (options.iterationCount ?? 1) > 1 ? `Running Tests (${options.iterationCount!} iterations)` : 'Running Tests',
      );
      currentExecution.onTrivetStart();

      setTrivetState((s) => ({
        ...s,
        runningTests: true,
        recentTestResults: undefined,
      }));
      const testSuitesToRun = options.testSuiteIds
        ? testSuites
            .filter((t) => options.testSuiteIds!.includes(t.id))
            .map((t) => ({
              ...t,
              testCases: options.testCaseIds
                ? t.testCases.filter((tc) => options.testCaseIds?.includes(tc.id))
                : t.testCases,
            }))
        : testSuites;
      try {
        const result = await runTrivet({
          project,
          iterationCount: options.iterationCount,
          testSuites: testSuitesToRun,
          onUpdate: (results) => {
            setTrivetState((s) => ({
              ...s,
              recentTestResults: results,
            }));
          },
          runGraph: async (project, graphId, inputs) => {
            await uploadProjectToExecutor(project);
            const resultsPromise = beginRemoteExecutionSession();

            const contextValues = buildContextValues();

            remoteDebugger.send('run', { graphId, inputs, contextValues, projectPath: loadedProject.path });

            const results = await resultsPromise;
            return results;
          },
        });
        setTrivetState((s) => ({
          ...s,
          recentTestResults: result,
          runningTests: false,
        }));
        toast.info(
          `Ran tests: ${result.testSuiteResults.length} tests, ${
            result.testSuiteResults.filter((t) => t.passing).length
          } passing`,
        );
      } catch (e) {
        console.error('Test run error:', e);
        setTrivetState((s) => ({
          ...s,
          runningTests: false,
        }));
        toast.error('Error running tests');
      }
    },
  );

  function tryAbortGraph() {
    remoteDebugger.send('abort', undefined);
  }

  function tryPauseGraph() {
    remoteDebugger.send('pause', undefined);
  }

  function tryResumeGraph() {
    remoteDebugger.send('resume', undefined);
  }

  return {
    remoteDebugger,
    tryRunGraph,
    tryAbortGraph,
    tryPauseGraph,
    tryResumeGraph,
    active: remoteDebugger.remoteDebuggerState.started,
    tryRunTests,
  };
}

function getDependentDataForNodeForPreload(dependencyNodes: NodeId[], previousRunData: RunDataByNodeId) {
  const preloadData: Record<NodeId, Outputs> = {};

  for (const dependencyNode of dependencyNodes) {
    const dependencyNodeData = previousRunData[dependencyNode];

    if (!dependencyNodeData) {
      throw new Error(`Node ${dependencyNode} was not found in the previous run data, cannot continue preloading data`);
    }

    const firstExecution = dependencyNodeData[0];

    if (!firstExecution?.data.outputData) {
      throw new Error(
        `Node ${dependencyNode} has no output data in the previous run data, cannot continue preloading data`,
      );
    }

    const { outputData } = firstExecution.data;

    // Convert back to DataValue from DataValueWithRefs
    const outputDataWithoutRefs = Object.fromEntries(
      Object.entries(outputData).map(([portId, dataValueWithRefs]) => {
        if (dataValueWithRefs.type === 'image') {
          throw new Error('Not implemented yet');
        } else if (dataValueWithRefs.type === 'binary') {
          throw new Error('Not implemented yet');
        } else if (dataValueWithRefs.type === 'audio') {
          throw new Error('Not implemented yet');
        } else {
          return [portId, dataValueWithRefs];
        }
      }),
    ) as Outputs;

    preloadData[dependencyNode] = outputDataWithoutRefs;
  }

  return preloadData;
}
