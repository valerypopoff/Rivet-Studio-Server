import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteWorkflowRecording as deleteWorkflowRecordingRequest,
  fetchWorkflowRecordingRuns,
  fetchWorkflowRecordingWorkflows,
} from './workflowApi';
import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilter,
  WorkflowRecordingInputFilterOperator,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingWorkflowListResponse,
} from './types';

export function useRunRecordingsController(isOpen: boolean) {
  const [workflowsResponse, setWorkflowsResponse] = useState<WorkflowRecordingWorkflowListResponse | null>(null);
  const [workflowsLoading, setWorkflowsLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const [runsPage, setRunsPage] = useState<WorkflowRecordingRunsPageResponse | null>(null);
  const [runsPerPage, setRunsPerPage] = useState<number>(20);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<WorkflowRecordingFilterStatus>('all');
  const [inputFilterVisible, setInputFilterVisible] = useState(false);
  const [inputFilterPath, setInputFilterPath] = useState('$');
  const [inputFilterOperator, setInputFilterOperator] = useState<WorkflowRecordingInputFilterOperator>('==');
  const [inputFilterValue, setInputFilterValue] = useState('');
  const [appliedInputFilter, setAppliedInputFilter] = useState<WorkflowRecordingInputFilter | null>(null);
  const [inputFilterError, setInputFilterError] = useState<string | null>(null);
  const [deletingRecordingId, setDeletingRecordingId] = useState<string | null>(null);

  const loadWorkflowRecordingWorkflows = useCallback(() => fetchWorkflowRecordingWorkflows(), []);
  const loadWorkflowRecordingRunsPage = useCallback((
    workflowId: string,
    options: {
      page: number;
      pageSize: number;
      status: WorkflowRecordingFilterStatus;
      inputFilter?: WorkflowRecordingInputFilter | null;
    },
  ) => fetchWorkflowRecordingRuns(workflowId, options), []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;
    setSelectedWorkflowId('');
    setRunsPage(null);
    setError(null);
    setPage(1);
    setRunsPerPage(20);
    setStatusFilter('all');
    setInputFilterVisible(false);
    setInputFilterPath('$');
    setInputFilterOperator('==');
    setInputFilterValue('');
    setAppliedInputFilter(null);
    setInputFilterError(null);
    setRunsLoading(false);
    setWorkflowsResponse(null);
    setWorkflowsLoading(true);
    setDeletingRecordingId(null);

    void loadWorkflowRecordingWorkflows()
      .then((response) => {
        if (!cancelled) {
          setWorkflowsResponse(response);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWorkflowsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, loadWorkflowRecordingWorkflows]);

  const workflows = useMemo(() => workflowsResponse?.workflows ?? [], [workflowsResponse]);

  useEffect(() => {
    if (workflows.length === 0) {
      setSelectedWorkflowId('');
      setPage(1);
      return;
    }

    if (!workflows.some((workflow) => workflow.workflowId === selectedWorkflowId)) {
      setSelectedWorkflowId(workflows[0]!.workflowId);
      setPage(1);
    }
  }, [selectedWorkflowId, workflows]);

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.workflowId === selectedWorkflowId) ?? null,
    [selectedWorkflowId, workflows],
  );

  useEffect(() => {
    if (!isOpen || !selectedWorkflowId) {
      return;
    }

    let cancelled = false;
    setRunsLoading(true);
    setRunsPage(null);
    setError(null);

    void loadWorkflowRecordingRunsPage(selectedWorkflowId, {
      page,
      pageSize: runsPerPage,
      status: statusFilter,
      inputFilter: appliedInputFilter,
    })
      .then((response) => {
        if (!cancelled) {
          setRunsPage(response);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [appliedInputFilter, isOpen, loadWorkflowRecordingRunsPage, page, runsPerPage, selectedWorkflowId, statusFilter]);

  const overallRunsCount = selectedWorkflow?.totalRuns ?? 0;
  const badRunsCount = (selectedWorkflow?.failedRuns ?? 0) + (selectedWorkflow?.suspiciousRuns ?? 0);
  const filteredRunsCount = runsPage?.totalRuns ?? (appliedInputFilter ? 0 : statusFilter === 'failed' ? badRunsCount : overallRunsCount);
  const totalPages = Math.max(1, Math.ceil(filteredRunsCount / runsPerPage));
  const visibleRuns = runsPage?.runs ?? [];

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const handleApplyInputFilter = useCallback(() => {
    const path = inputFilterPath.trim();
    if (!path.startsWith('$')) {
      setInputFilterError('JSON path must start with $');
      return;
    }

    setInputFilterError(null);
    setAppliedInputFilter({
      path,
      operator: inputFilterOperator,
      value: inputFilterOperator === 'exists' || inputFilterOperator === 'not_exists'
        ? ''
        : inputFilterValue,
    });
    setPage(1);
  }, [inputFilterOperator, inputFilterPath, inputFilterValue]);

  const handleClearInputFilter = useCallback(() => {
    setInputFilterError(null);
    setAppliedInputFilter(null);
    setInputFilterPath('$');
    setInputFilterOperator('==');
    setInputFilterValue('');
    setPage(1);
  }, []);

  const handleSetInputFilterVisible = useCallback((visible: boolean) => {
    setInputFilterVisible(visible);
    setInputFilterError(null);
    if (!visible) {
      setAppliedInputFilter(null);
      setPage(1);
    }
  }, []);

  const handleDeleteRecording = useCallback(async (recordingId: string) => {
    if (!window.confirm('Are you sure you want to delete this recording? This action cannot be undone.')) {
      return;
    }

    const currentWorkflowId = selectedWorkflowId;
    const currentPage = page;
    const currentPageSize = runsPerPage;
    const currentStatusFilter = statusFilter;
    const currentInputFilter = appliedInputFilter;

    try {
      setDeletingRecordingId(recordingId);
      setRunsLoading(true);
      setError(null);

      await deleteWorkflowRecordingRequest(recordingId);

      const nextWorkflowsResponse = await loadWorkflowRecordingWorkflows();
      setWorkflowsResponse(nextWorkflowsResponse);

      const refreshedWorkflow = nextWorkflowsResponse.workflows.find((workflow) => workflow.workflowId === currentWorkflowId) ?? null;
      if (!refreshedWorkflow) {
        setRunsPage(null);
        return;
      }

      setRunsPage(null);
      let nextRunsPage = await loadWorkflowRecordingRunsPage(refreshedWorkflow.workflowId, {
        page: currentPage,
        pageSize: currentPageSize,
        status: currentStatusFilter,
        inputFilter: currentInputFilter,
      });
      if (nextRunsPage.totalRuns > 0 && nextRunsPage.runs.length === 0 && currentPage > 1) {
        const nextPage = Math.max(1, Math.ceil(nextRunsPage.totalRuns / currentPageSize));
        setPage(nextPage);
        nextRunsPage = await loadWorkflowRecordingRunsPage(refreshedWorkflow.workflowId, {
          page: nextPage,
          pageSize: currentPageSize,
          status: currentStatusFilter,
          inputFilter: currentInputFilter,
        });
      }

      setRunsPage(nextRunsPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunsLoading(false);
      setDeletingRecordingId(null);
    }
  }, [
    loadWorkflowRecordingRunsPage,
    loadWorkflowRecordingWorkflows,
    page,
    runsPerPage,
    selectedWorkflowId,
    statusFilter,
    appliedInputFilter,
  ]);

  return {
    workflows,
    workflowsLoading,
    runsLoading,
    error,
    selectedWorkflowId,
    selectedWorkflow,
    runsPage,
    runsPerPage,
    page,
    statusFilter,
    inputFilterVisible,
    inputFilterPath,
    inputFilterOperator,
    inputFilterValue,
    appliedInputFilter,
    inputFilterError,
    deletingRecordingId,
    overallRunsCount,
    badRunsCount,
    filteredRunsCount,
    totalPages,
    visibleRuns,
    setSelectedWorkflowId,
    setRunsPerPage,
    setPage,
    setStatusFilter,
    setInputFilterPath,
    setInputFilterOperator,
    setInputFilterValue,
    setInputFilterVisible: handleSetInputFilterVisible,
    handleApplyInputFilter,
    handleClearInputFilter,
    handleDeleteRecording,
  };
}
