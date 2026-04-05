import { type OpenedProjectInfo, loadedProjectState, projectState } from '../../../../rivet/packages/app/src/state/savedGraphs.js';
import { emptyNodeGraph, getError } from '@ironclad/rivet-core';
import { graphState, historicalGraphState, isReadOnlyGraphState } from '../../../../rivet/packages/app/src/state/graph.js';
import { ioProvider } from '../../../../rivet/packages/app/src/utils/globals.js';
import { trivetState } from '../../../../rivet/packages/app/src/state/trivet.js';
import { useSetStaticData } from '../../../../rivet/packages/app/src/hooks/useSetStaticData.js';
import { toast } from 'react-toastify';
import { graphNavigationStackState } from '../../../../rivet/packages/app/src/state/graphBuilder.js';
import { useSetAtom } from 'jotai';
import { getOpenedProjectSession, primeOpenedProjectSession } from '../../io/openedProjectSessionCache.js';

export function useLoadProject() {
  const setProject = useSetAtom(projectState);
  const setLoadedProjectState = useSetAtom(loadedProjectState);
  const setGraphData = useSetAtom(graphState);
  const setTrivetState = useSetAtom(trivetState);
  const setStaticData = useSetStaticData();
  const setNavigationStack = useSetAtom(graphNavigationStackState);
  const setIsReadOnlyGraph = useSetAtom(isReadOnlyGraphState);
  const setHistoricalGraph = useSetAtom(historicalGraphState);

  return async (projectInfo: OpenedProjectInfo) => {
    try {
      setProject(projectInfo.project);

      setNavigationStack({ stack: [], index: undefined });

      setIsReadOnlyGraph(false);
      setHistoricalGraph(null);

      if (projectInfo.openedGraph) {
        const graphData = projectInfo.project.graphs[projectInfo.openedGraph];
        if (graphData) {
          setGraphData(graphData);
        } else {
          setGraphData(emptyNodeGraph());
        }
      } else {
        setGraphData(emptyNodeGraph());
      }

      if (projectInfo.project.data) {
        setStaticData(projectInfo.project.data);
      }

      setLoadedProjectState({
        path: projectInfo.fsPath ?? '',
        loaded: true,
      });

      if (projectInfo.fsPath) {
        let testData = getOpenedProjectSession(projectInfo.project.metadata.id, projectInfo.fsPath);

        if (!testData) {
          const loadedProject = await ioProvider.loadProjectDataNoPrompt(projectInfo.fsPath);
          testData = loadedProject.testData;
          primeOpenedProjectSession(projectInfo.project.metadata.id, {
            fsPath: projectInfo.fsPath,
            testData,
          });
        }

        setTrivetState({
          testSuites: testData.testSuites,
          selectedTestSuiteId: undefined,
          editingTestCaseId: undefined,
          recentTestResults: undefined,
          runningTests: false,
        });
      } else {
        setTrivetState({
          testSuites: [],
          selectedTestSuiteId: undefined,
          editingTestCaseId: undefined,
          recentTestResults: undefined,
          runningTests: false,
        });
      }
    } catch (err) {
      toast.error(`Failed to load project: ${getError(err).message}`);
    }
  };
}
