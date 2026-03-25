import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import Select from '@atlaskit/select';
import { useCallback, useEffect, useMemo, useState, type FC } from 'react';

import { fetchWorkflowRecordings } from './workflowApi';
import type {
  WorkflowProjectStatus,
  WorkflowRecordingGroup,
  WorkflowRecordingItem,
  WorkflowRecordingListResponse,
  WorkflowRecordingStatus,
} from './types';
import './RunRecordingsModal.css';

interface RunRecordingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenRecording: (projectPath: string, recordingPath: string) => void;
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

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return timestampFormatter.format(date);
}

function toSortableTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getWorkflowLatestRunAt(workflow: WorkflowRecordingGroup): string {
  return workflow.recordings[0]?.createdAt ?? '';
}

function getWorkflowEndpoint(workflow: WorkflowRecordingGroup): string {
  return workflow.project.settings.endpointName || workflow.recordings[0]?.endpointNameAtExecution || '';
}

function RecordingRow({
  recording,
  onOpen,
}: {
  recording: WorkflowRecordingItem;
  onOpen: (projectPath: string, recordingPath: string) => void;
}) {
  return (
    <button
      type="button"
      className={`run-recordings-run ${recording.status}`}
      onClick={() => onOpen(recording.replayProjectPath, recording.recordingPath)}
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
      {recording.errorMessage ? (
        <div className="run-recordings-run-error">{recording.errorMessage}</div>
      ) : null}
    </button>
  );
}

export const RunRecordingsModal: FC<RunRecordingsModalProps> = ({
  isOpen,
  onClose,
  onOpenRecording,
}) => {
  const [data, setData] = useState<WorkflowRecordingListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorkflowPath, setSelectedWorkflowPath] = useState('');
  const [runsPerPage, setRunsPerPage] = useState<number>(20);
  const [page, setPage] = useState(1);
  const [failedOnly, setFailedOnly] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetchWorkflowRecordings();
      const sortedWorkflows = [...response.workflows]
        .map((workflow) => ({
          ...workflow,
          recordings: [...workflow.recordings].sort(
            (left, right) => toSortableTimestamp(right.createdAt) - toSortableTimestamp(left.createdAt),
          ),
        }))
        .sort(
          (left, right) =>
            toSortableTimestamp(getWorkflowLatestRunAt(right)) - toSortableTimestamp(getWorkflowLatestRunAt(left)),
        );

      setData({ workflows: sortedWorkflows });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    void refresh();
  }, [isOpen, refresh]);

  const workflows = useMemo(() => data?.workflows ?? [], [data]);

  useEffect(() => {
    if (workflows.length === 0) {
      setSelectedWorkflowPath('');
      setPage(1);
      return;
    }

    const selectedWorkflowStillExists = workflows.some((workflow) => workflow.project.absolutePath === selectedWorkflowPath);
    if (!selectedWorkflowStillExists) {
      setSelectedWorkflowPath(workflows[0]!.project.absolutePath);
      setPage(1);
    }
  }, [selectedWorkflowPath, workflows]);

  useEffect(() => {
    setPage(1);
  }, [failedOnly, runsPerPage, selectedWorkflowPath]);

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.project.absolutePath === selectedWorkflowPath) ?? null,
    [selectedWorkflowPath, workflows],
  );

  const workflowOptions = useMemo<WorkflowOption[]>(
    () =>
      workflows.map((workflow) => {
        const latestRunAt = getWorkflowLatestRunAt(workflow);
        const endpoint = getWorkflowEndpoint(workflow);
        const statusLabel = PROJECT_STATUS_LABELS[workflow.project.settings.status];

        return {
          label: workflow.project.name,
          value: workflow.project.absolutePath,
          description: latestRunAt ? `Last run ${formatTimestamp(latestRunAt)}` : 'No recorded runs yet',
          endpoint,
          statusLabel,
        };
      }),
    [workflows],
  );

  const filteredRuns = useMemo(() => {
    if (!selectedWorkflow) {
      return [];
    }

    return selectedWorkflow.recordings.filter((recording) => !failedOnly || recording.status === 'failed');
  }, [failedOnly, selectedWorkflow]);

  const totalRuns = filteredRuns.length;
  const totalPages = Math.max(1, Math.ceil(totalRuns / runsPerPage));

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const pagedRuns = useMemo(() => {
    const startIndex = (page - 1) * runsPerPage;
    return filteredRuns.slice(startIndex, startIndex + runsPerPage);
  }, [filteredRuns, page, runsPerPage]);

  const selectedWorkflowEndpoint = selectedWorkflow ? getWorkflowEndpoint(selectedWorkflow) : '';
  const selectedWorkflowStatusLabel = selectedWorkflow
    ? PROJECT_STATUS_LABELS[selectedWorkflow.project.settings.status]
    : '';
  const firstVisibleRun = totalRuns === 0 ? 0 : (page - 1) * runsPerPage + 1;
  const lastVisibleRun = totalRuns === 0 ? 0 : Math.min(totalRuns, page * runsPerPage);

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
                ×
              </button>
            </div>

            <div className="project-settings-modal-content run-recordings-content">
              {error ? (
                <div className="project-settings-error run-recordings-error">{error}</div>
              ) : null}

              {loading ? (
                <div className="run-recordings-empty-state">Loading recordings...</div>
              ) : null}

              {!loading && workflows.length === 0 ? (
                <div className="run-recordings-empty-state">No published or previously published workflows yet.</div>
              ) : null}

              {!loading && workflows.length > 0 ? (
                <div className="run-recordings-layout">
                  <section className="run-recordings-selector-section">
                    <div className="run-recordings-field-label">Workflow</div>
                    <Select
                      inputId="run-recordings-workflow-select"
                      options={workflowOptions}
                      value={workflowOptions.find((option) => option.value === selectedWorkflowPath) ?? null}
                      onChange={(option: any) => {
                        setSelectedWorkflowPath(option?.value ?? '');
                      }}
                      isSearchable={workflows.length > 8}
                      classNamePrefix="run-recordings-select"
                      formatOptionLabel={(option: WorkflowOption, { context }: any) => (
                        <div className="run-recordings-select-option">
                          <div className="run-recordings-select-option-title">{option.label}</div>
                          {context === 'menu' ? (
                            <div className="run-recordings-select-option-meta">
                              {option.statusLabel}
                              {option.endpoint ? ` · /workflows/${option.endpoint}` : ''}
                              {option.description ? ` · ${option.description}` : ''}
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
                          <div className="run-recordings-workflow-field">
                            <div className="run-recordings-field-label">Recorded runs</div>
                            <div className="run-recordings-field-value">{selectedWorkflow.recordings.length}</div>
                          </div>
                        </div>
                      </div>

                      <div className="run-recordings-runs-panel">
                        <div className="run-recordings-runs-header">
                          <div className="run-recordings-runs-heading-group">
                            <div className="run-recordings-runs-title">Runs</div>
                            <div className="run-recordings-segmented" role="group" aria-label="Filter runs">
                              <button
                                type="button"
                                className={`run-recordings-segmented-button${!failedOnly ? ' active' : ''}`}
                                onClick={() => setFailedOnly(false)}
                              >
                                All
                              </button>
                              <button
                                type="button"
                                className={`run-recordings-segmented-button${failedOnly ? ' active' : ''}`}
                                onClick={() => setFailedOnly(true)}
                              >
                                Failed only
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
                                    onClick={() => setRunsPerPage(option)}
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
                                disabled={page <= 1}
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
                                disabled={page >= totalPages}
                              >
                                Next
                              </button>
                            </div>
                          </div>
                        </div>

                        {totalRuns === 0 ? (
                          <div className="run-recordings-empty-group">
                            {failedOnly ? 'No failed runs for this workflow.' : 'No recorded runs yet.'}
                          </div>
                        ) : (
                          <>
                            <div className="run-recordings-list">
                              {pagedRuns.map((recording) => (
                                <RecordingRow
                                  key={recording.id}
                                  recording={recording}
                                  onOpen={onOpenRecording}
                                />
                              ))}
                            </div>
                            <div className="run-recordings-pagination-footer">
                              Page {page} of {totalPages}
                            </div>
                          </>
                        )}
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
