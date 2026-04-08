import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteWorkflowRecording as deleteWorkflowRecordingRequest,
  fetchWorkflowRecordingRuns,
  fetchWorkflowRecordingWorkflows,
} from './workflowApi';
import type {
  WorkflowRecordingFilterStatus,
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
  const [deletingRecordingId, setDeletingRecordingId] = useState<string | null>(null);

  const loadWorkflowRecordingWorkflows = useCallback(() => fetchWorkflowRecordingWorkflows(), []);
  const loadWorkflowRecordingRunsPage = useCallback((
    workflowId: string,
    options: {
      page: number;
      pageSize: number;
      status: WorkflowRecordingFilterStatus;
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
  }, [isOpen, loadWorkflowRecordingRunsPage, page, runsPerPage, selectedWorkflowId, statusFilter]);

  const overallRunsCount = selectedWorkflow?.totalRuns ?? 0;
  const badRunsCount = (selectedWorkflow?.failedRuns ?? 0) + (selectedWorkflow?.suspiciousRuns ?? 0);
  const filteredRunsCount = runsPage?.totalRuns ?? (statusFilter === 'failed' ? badRunsCount : overallRunsCount);
  const totalPages = Math.max(1, Math.ceil(filteredRunsCount / runsPerPage));
  const visibleRuns = runsPage?.runs ?? [];

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const handleDeleteRecording = useCallback(async (recordingId: string) => {
    if (!window.confirm('Are you sure you want to delete this recording? This action cannot be undone.')) {
      return;
    }

    const currentWorkflowId = selectedWorkflowId;
    const currentPage = page;
    const currentPageSize = runsPerPage;
    const currentStatusFilter = statusFilter;

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

      const refreshedFilteredRunsCount = currentStatusFilter === 'failed'
        ? refreshedWorkflow.failedRuns + refreshedWorkflow.suspiciousRuns
        : refreshedWorkflow.totalRuns;
      const nextPage = Math.min(currentPage, Math.max(1, Math.ceil(refreshedFilteredRunsCount / currentPageSize)));
      if (nextPage !== currentPage) {
        setPage(nextPage);
      }

      if (refreshedFilteredRunsCount === 0) {
        setRunsPage({
          workflowId: refreshedWorkflow.workflowId,
          page: nextPage,
          pageSize: currentPageSize,
          totalRuns: 0,
          statusFilter: currentStatusFilter,
          runs: [],
        });
        return;
      }

      setRunsPage(null);
      setRunsPage(await loadWorkflowRecordingRunsPage(refreshedWorkflow.workflowId, {
        page: nextPage,
        pageSize: currentPageSize,
        status: currentStatusFilter,
      }));
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
    handleDeleteRecording,
  };
}
