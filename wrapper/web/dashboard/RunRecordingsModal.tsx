import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import Select from '@atlaskit/select';
import { useEffect, useMemo, useState, type FC } from 'react';

import {
  fetchWorkflowRecordingRuns,
  fetchWorkflowRecordingWorkflows,
} from './workflowApi';
import type {
  WorkflowProjectStatus,
  WorkflowRecordingFilterStatus,
  WorkflowRecordingRunSummary,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingStatus,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRecordingWorkflowSummary,
} from './types';
import './RunRecordingsModal.css';

interface RunRecordingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenRecording: (recordingId: string) => void;
}

type WorkflowOption = {
  label: string;
  value: string;
  description: string;
  endpoint: string;
  statusLabel: string;
};

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const PROJECT_STATUS_LABELS: Record<WorkflowProjectStatus, string> = {
  unpublished: 'Unpublished',
  published: 'Published',
  unpublished_changes: 'Unpublished changes',
};

const RUN_STATUS_LABELS: Record<WorkflowRecordingStatus, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  suspicious: 'Suspicious',
};

const runsPerPageOptions = [10, 20, 50, 100] as const;

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }

  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainderSeconds}s`;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return 'Never';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return timestampFormatter.format(date);
}

function getWorkflowEndpoint(workflow: WorkflowRecordingWorkflowSummary): string {
  return workflow.project.settings.endpointName || '';
}

function RecordingRow({
  recording,
  onOpen,
}: {
  recording: WorkflowRecordingRunSummary;
  onOpen: (recordingId: string) => void;
}) {
  const detailText = recording.errorMessage ??
    (recording.status === 'suspicious'
      ? 'Completed without throwing, but the final output was control-flow-excluded.'
      : null);

  return (
    <button
      type="button"
      className={`run-recordings-run ${recording.status}`}
      onClick={() => onOpen(recording.id)}
    >
      <div className="run-recordings-run-header">
        <div className="run-recordings-run-main">
          <div className="run-recordings-run-title">{formatTimestamp(recording.createdAt)}</div>
        </div>
        <div className="run-recordings-run-meta">
          {recording.runKind === 'latest' ? (
            <span className="run-recordings-badge latest">Latest</span>
          ) : null}
          <span className={`run-recordings-badge ${recording.status}`}>
            {RUN_STATUS_LABELS[recording.status]}
          </span>
          <span className="run-recordings-run-duration">{formatDuration(recording.durationMs)}</span>
        </div>
      </div>
      {detailText ? (
        <div className={`run-recordings-run-detail ${recording.status}`}>
          {detailText}
        </div>
      ) : null}
    </button>
  );
}

export const RunRecordingsModal: FC<RunRecordingsModalProps> = ({
  isOpen,
  onClose,
  onOpenRecording,
}) => {
  const [workflowsResponse, setWorkflowsResponse] = useState<WorkflowRecordingWorkflowListResponse | null>(null);
  const [workflowsLoading, setWorkflowsLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const [runsPage, setRunsPage] = useState<WorkflowRecordingRunsPageResponse | null>(null);
  const [runsPerPage, setRunsPerPage] = useState<number>(20);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<WorkflowRecordingFilterStatus>('all');

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

    void fetchWorkflowRecordingWorkflows()
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
  }, [isOpen]);

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

    void fetchWorkflowRecordingRuns(selectedWorkflowId, {
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
  }, [isOpen, page, runsPerPage, selectedWorkflowId, statusFilter]);

  const workflowOptions = useMemo<WorkflowOption[]>(
    () =>
      workflows.map((workflow) => {
        const endpoint = getWorkflowEndpoint(workflow);
        const statusLabel = PROJECT_STATUS_LABELS[workflow.project.settings.status];

        return {
          label: workflow.project.name,
          value: workflow.workflowId,
          description: workflow.latestRunAt ? `Last run ${formatTimestamp(workflow.latestRunAt)}` : 'No recorded runs yet',
          endpoint,
          statusLabel,
        };
      }),
    [workflows],
  );

  const totalRuns = runsPage?.totalRuns ?? (selectedWorkflow?.totalRuns ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalRuns / runsPerPage));
  const visibleRuns = runsPage?.runs ?? [];
  const firstVisibleRun = totalRuns === 0 ? 0 : (page - 1) * runsPerPage + 1;
  const lastVisibleRun = totalRuns === 0 ? 0 : Math.min(totalRuns, (page - 1) * runsPerPage + visibleRuns.length);
  const selectedWorkflowEndpoint = selectedWorkflow ? getWorkflowEndpoint(selectedWorkflow) : '';
  const selectedWorkflowStatusLabel = selectedWorkflow
    ? PROJECT_STATUS_LABELS[selectedWorkflow.project.settings.status]
    : '';

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  if (!isOpen) {
    return null;
  }

  return (
    <ModalTransition>
      <ModalDialog
        testId="run-recordings-modal"
        width="large"
        label="Run recordings"
        onClose={onClose}
      >
        <ModalBody>
          <div className="project-settings-modal-shell run-recordings-shell">
            <div className="project-settings-modal-header-row run-recordings-header-row">
              <div className="project-settings-modal-heading run-recordings-heading">
                <div className="project-settings-modal-title run-recordings-title">Run recordings</div>
                <div className="run-recordings-help">
                  Choose a workflow, inspect its published run history, and open any recording in the editor.
                </div>
              </div>
              <button
                type="button"
                className="project-settings-close-button"
                onClick={onClose}
                aria-label="Close run recordings"
              >
                &times;
              </button>
            </div>

            <div className="project-settings-modal-content run-recordings-content">
              {error ? (
                <div className="project-settings-error run-recordings-error">{error}</div>
              ) : null}

              {workflowsLoading ? (
                <div className="run-recordings-empty-state">Loading recordings...</div>
              ) : null}

              {!workflowsLoading && workflows.length === 0 ? (
                <div className="run-recordings-empty-state">No published or previously published workflows yet.</div>
              ) : null}

              {!workflowsLoading && workflows.length > 0 ? (
                <div className="run-recordings-layout">
                  <section className="run-recordings-selector-section">
                    <div className="run-recordings-field-label">Workflow</div>
                    <Select
                      inputId="run-recordings-workflow-select"
                      options={workflowOptions}
                      value={workflowOptions.find((option) => option.value === selectedWorkflowId) ?? null}
                      onChange={(option: WorkflowOption | null) => {
                        setSelectedWorkflowId(option?.value ?? '');
                        setPage(1);
                      }}
                      isSearchable={workflows.length > 8}
                      classNamePrefix="run-recordings-select"
                      formatOptionLabel={(option: WorkflowOption, { context }: { context: 'menu' | 'value' }) => (
                        <div className="run-recordings-select-option">
                          <div className="run-recordings-select-option-title">{option.label}</div>
                          {context === 'menu' ? (
                            <div className="run-recordings-select-option-meta">
                              {option.statusLabel}
                              {option.endpoint ? ` - /workflows/${option.endpoint}` : ''}
                              {option.description ? ` - ${option.description}` : ''}
                            </div>
                          ) : null}
                        </div>
                      )}
                    />
                  </section>

                  {selectedWorkflow ? (
                    <section className="run-recordings-details">
                      <div className="run-recordings-workflow-summary">
                        <div className="run-recordings-workflow-heading-row">
                          <span className={`project-status-badge ${selectedWorkflow.project.settings.status}`}>
                            {selectedWorkflowStatusLabel}
                          </span>
                          <div className="run-recordings-workflow-name">{selectedWorkflow.project.name}</div>
                        </div>

                        <div className="run-recordings-workflow-fields">
                          <div className="run-recordings-workflow-field run-recordings-workflow-field-wide">
                            <div className="run-recordings-field-label">Endpoint</div>
                            <div className="run-recordings-field-value run-recordings-field-code">
                              {selectedWorkflowEndpoint ? `/workflows/${selectedWorkflowEndpoint}` : 'No endpoint configured'}
                            </div>
                          </div>
                          <div className="run-recordings-workflow-field">
                            <div className="run-recordings-field-label">Project path</div>
                            <div className="run-recordings-field-value run-recordings-field-code">
                              {selectedWorkflow.project.relativePath}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="run-recordings-runs-panel">
                        <div className="run-recordings-runs-header">
                          <div className="run-recordings-runs-heading-group">
                            <div className="run-recordings-runs-title">
                              {totalRuns} {totalRuns === 1 ? 'Run' : 'Runs'}
                            </div>
                            <div className="run-recordings-segmented" role="group" aria-label="Filter runs">
                              <button
                                type="button"
                                className={`run-recordings-segmented-button${statusFilter === 'all' ? ' active' : ''}`}
                                onClick={() => {
                                  setStatusFilter('all');
                                  setPage(1);
                                }}
                              >
                                All
                              </button>
                              <button
                                type="button"
                                className={`run-recordings-segmented-button${statusFilter === 'failed' ? ' active' : ''}`}
                                onClick={() => {
                                  setStatusFilter('failed');
                                  setPage(1);
                                }}
                              >
                                Bad only
                              </button>
                            </div>
                          </div>

                          <div className="run-recordings-runs-controls">
                            <div className="run-recordings-inline-control">
                              <span className="run-recordings-field-label">Per page</span>
                              <div className="run-recordings-segmented" role="group" aria-label="Runs per page">
                                {runsPerPageOptions.map((option) => (
                                  <button
                                    key={option}
                                    type="button"
                                    className={`run-recordings-segmented-button${runsPerPage === option ? ' active' : ''}`}
                                    onClick={() => {
                                      setRunsPerPage(option);
                                      setPage(1);
                                    }}
                                  >
                                    {option}
                                  </button>
                                ))}
                              </div>
                            </div>

                            <div className="run-recordings-pagination">
                              <button
                                type="button"
                                className="run-recordings-page-button"
                                onClick={() => setPage((current) => Math.max(1, current - 1))}
                                disabled={page <= 1 || runsLoading}
                              >
                                Previous
                              </button>
                              <div className="run-recordings-page-status">
                                {firstVisibleRun}-{lastVisibleRun} of {totalRuns}
                              </div>
                              <button
                                type="button"
                                className="run-recordings-page-button"
                                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                                disabled={page >= totalPages || runsLoading}
                              >
                                Next
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="run-recordings-runs-body">
                          {runsLoading ? (
                            <div className="run-recordings-empty-group">Loading runs...</div>
                          ) : totalRuns === 0 ? (
                            <div className="run-recordings-empty-group">
                              {statusFilter === 'failed' ? 'No bad runs for this workflow.' : 'No recorded runs yet.'}
                            </div>
                          ) : (
                            <div className="run-recordings-list">
                              {visibleRuns.map((recording) => (
                                <RecordingRow
                                  key={recording.id}
                                  recording={recording}
                                  onOpen={onOpenRecording}
                                />
                              ))}
                            </div>
                          )}
                        </div>

                        {totalRuns > 0 ? (
                          <div className="run-recordings-pagination-footer">
                            Page {page} of {totalPages}
                          </div>
                        ) : null}
                      </div>
                    </section>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
