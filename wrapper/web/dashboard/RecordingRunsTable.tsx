import { type FC } from 'react';

import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingRunSummary,
  WorkflowRecordingStatus,
  WorkflowRecordingWorkflowSummary,
} from './types';

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

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

function RecordingRow({
  recording,
  isDeleting,
  onDelete,
  onOpen,
}: {
  recording: WorkflowRecordingRunSummary;
  isDeleting: boolean;
  onDelete: (recordingId: string) => void;
  onOpen: (recordingId: string) => void;
}) {
  const detailText = recording.errorMessage ??
    (recording.status === 'suspicious'
      ? 'Completed without throwing, but the final output was control-flow-excluded.'
      : null);

  return (
    <div className={`run-recordings-run ${recording.status}`}>
      <button
        type="button"
        className="run-recordings-run-open-button"
        onClick={() => onOpen(recording.id)}
        disabled={isDeleting}
      >
        <div className="run-recordings-run-body">
          <div className="run-recordings-run-header">
            <div className="run-recordings-run-main">
              <div className="run-recordings-run-title">{formatTimestamp(recording.createdAt)}</div>
              {recording.runKind === 'latest' ? (
                <span className="run-recordings-badge latest">Latest</span>
              ) : null}
            </div>
          </div>
          {detailText ? (
            <div className={`run-recordings-run-detail ${recording.status}`}>
              {detailText}
            </div>
          ) : null}
        </div>
        <div className="run-recordings-run-footer">
          <div className="run-recordings-run-meta">
            <span className={`run-recordings-badge ${recording.status}`}>
              {RUN_STATUS_LABELS[recording.status]}
            </span>
            <span className="run-recordings-run-duration">{formatDuration(recording.durationMs)}</span>
          </div>
        </div>
      </button>
      <div className="run-recordings-run-actions">
        <button
          type="button"
          className="run-recordings-run-delete-button"
          onClick={() => onDelete(recording.id)}
          disabled={isDeleting}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

type RecordingRunsTableProps = {
  selectedWorkflow: WorkflowRecordingWorkflowSummary;
  selectedWorkflowEndpoint: string;
  selectedWorkflowStatusLabel: string;
  overallRunsCount: number;
  badRunsCount: number;
  filteredRunsCount: number;
  totalPages: number;
  page: number;
  runsPerPage: number;
  statusFilter: WorkflowRecordingFilterStatus;
  runsLoading: boolean;
  visibleRuns: WorkflowRecordingRunSummary[];
  deletingRecordingId: string | null;
  onSetStatusFilter: (status: WorkflowRecordingFilterStatus) => void;
  onSetRunsPerPage: (pageSize: number) => void;
  onSetPage: (page: number | ((current: number) => number)) => void;
  onDeleteRecording: (recordingId: string) => void;
  onOpenRecording: (recordingId: string) => void;
};

export const RecordingRunsTable: FC<RecordingRunsTableProps> = ({
  selectedWorkflow,
  selectedWorkflowEndpoint,
  selectedWorkflowStatusLabel,
  overallRunsCount,
  badRunsCount,
  filteredRunsCount,
  totalPages,
  page,
  runsPerPage,
  statusFilter,
  runsLoading,
  visibleRuns,
  deletingRecordingId,
  onSetStatusFilter,
  onSetRunsPerPage,
  onSetPage,
  onDeleteRecording,
  onOpenRecording,
}) => {
  const allRunsLabel = overallRunsCount > 0 ? `All (${overallRunsCount})` : 'All';
  const badRunsLabel = badRunsCount > 0 ? `Bad only (${badRunsCount})` : 'Bad only';

  return (
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
              {overallRunsCount} {overallRunsCount === 1 ? 'Run' : 'Runs'}
            </div>
            <div className="run-recordings-segmented" role="group" aria-label="Filter runs">
              <button
                type="button"
                className={`run-recordings-segmented-button${statusFilter === 'all' ? ' active' : ''}`}
                onClick={() => {
                  onSetStatusFilter('all');
                  onSetPage(1);
                }}
              >
                {allRunsLabel}
              </button>
              <button
                type="button"
                className={`run-recordings-segmented-button${statusFilter === 'failed' ? ' active' : ''}`}
                onClick={() => {
                  onSetStatusFilter('failed');
                  onSetPage(1);
                }}
              >
                {badRunsLabel}
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
                      onSetRunsPerPage(option);
                      onSetPage(1);
                    }}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="run-recordings-runs-body">
          {runsLoading ? (
            <div className="run-recordings-empty-group">Loading runs...</div>
          ) : filteredRunsCount === 0 ? (
            <div className="run-recordings-empty-group">
              {statusFilter === 'failed' ? 'No bad runs for this workflow.' : 'No recorded runs yet.'}
            </div>
          ) : (
            <div className="run-recordings-list">
              {visibleRuns.map((recording) => (
                <RecordingRow
                  key={recording.id}
                  recording={recording}
                  isDeleting={deletingRecordingId === recording.id}
                  onDelete={onDeleteRecording}
                  onOpen={onOpenRecording}
                />
              ))}
            </div>
          )}
        </div>

        {filteredRunsCount > 0 && totalPages > 1 ? (
          <div className="run-recordings-pagination-footer">
            <button
              type="button"
              className="run-recordings-page-button"
              onClick={() => onSetPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1 || runsLoading}
            >
              Previous
            </button>
            <div className="run-recordings-page-status">
              Page {page} of {totalPages}
            </div>
            <button
              type="button"
              className="run-recordings-page-button"
              onClick={() => onSetPage((current) => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages || runsLoading}
            >
              Next
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
};
