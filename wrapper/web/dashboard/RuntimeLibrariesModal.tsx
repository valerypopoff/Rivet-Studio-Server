import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import {
  fetchRuntimeLibraries,
  installPackages,
  removePackages,
  streamJobLogs,
  type RuntimeLibrariesState,
  type JobState,
  type SSEEvent,
} from './runtimeLibrariesApi';
import './RuntimeLibrariesModal.css';

interface RuntimeLibrariesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const RuntimeLibrariesModal: FC<RuntimeLibrariesModalProps> = ({ isOpen, onClose }) => {
  const [state, setState] = useState<RuntimeLibrariesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add form
  const [addName, setAddName] = useState('');
  const [addVersion, setAddVersion] = useState('latest');

  // Job tracking
  const [activeJob, setActiveJob] = useState<JobState | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [jobResult, setJobResult] = useState<{ status: 'succeeded' | 'failed'; error?: string } | null>(null);

  const logPanelRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const isJobActive = activeJob != null &&
    activeJob.status !== 'succeeded' &&
    activeJob.status !== 'failed';

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchRuntimeLibraries();
      setState(data);

      // If there's an active job in progress, start streaming
      if (data.activeJob && data.activeJob.status !== 'succeeded' && data.activeJob.status !== 'failed') {
        setActiveJob(data.activeJob);
        setLogs(data.activeJob.logs ?? []);
        startStreaming(data.activeJob.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      refresh();
    }

    return () => {
      eventSourceRef.current?.close();
    };
  }, [isOpen, refresh]);

  // Auto-scroll log panel
  useEffect(() => {
    if (logPanelRef.current) {
      logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
    }
  }, [logs]);

  const startStreaming = useCallback((jobId: string) => {
    eventSourceRef.current?.close();

    const source = streamJobLogs(
      jobId,
      (event: SSEEvent) => {
        if (event.type === 'log' && event.message) {
          setLogs((prev) => [...prev, event.message!]);
        }
        if (event.type === 'status' && event.status) {
          setActiveJob((prev) => prev ? { ...prev, status: event.status! } : prev);
        }
        if (event.type === 'done') {
          setJobResult({ status: event.status as 'succeeded' | 'failed', error: event.error });
          setActiveJob((prev) => prev ? { ...prev, status: event.status! } : prev);
          // Refresh to get updated package list
          refresh();
        }
      },
    );

    eventSourceRef.current = source;
  }, [refresh]);

  const handleInstall = useCallback(async () => {
    if (!addName.trim()) return;

    try {
      setError(null);
      setJobResult(null);
      setLogs([]);
      const job = await installPackages([{ name: addName.trim(), version: addVersion.trim() || 'latest' }]);
      setActiveJob(job);
      setLogs(job.logs ?? []);
      startStreaming(job.id);
      setAddName('');
      setAddVersion('latest');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [addName, addVersion, startStreaming]);

  const handleRemove = useCallback(async (packageName: string) => {
    try {
      setError(null);
      setJobResult(null);
      setLogs([]);
      const job = await removePackages([packageName]);
      setActiveJob(job);
      setLogs(job.logs ?? []);
      startStreaming(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [startStreaming]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isJobActive && addName.trim()) {
      handleInstall();
    }
  }, [handleInstall, isJobActive, addName]);

  if (!isOpen) return null;

  const packages = state ? Object.values(state.packages) : [];

  return (
    <div className="runtime-libraries-overlay" onClick={onClose}>
      <div className="runtime-libraries-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Runtime Libraries</h3>
          <button className="close-button" onClick={onClose} title="Close">&times;</button>
        </div>

        <div className="modal-body">
          {error ? (
            <div className="status-area failed">{error}</div>
          ) : null}

          {/* Installed libraries */}
          <div>
            <div className="section-title">Installed Libraries</div>
            {loading && !state ? (
              <div className="empty-state">Loading...</div>
            ) : packages.length === 0 ? (
              <div className="empty-state">No runtime libraries installed</div>
            ) : (
              <div className="installed-list">
                {packages.map((pkg) => (
                  <div key={pkg.name} className="installed-item">
                    <div className="pkg-info">
                      <span className="pkg-name">{pkg.name}</span>
                      <span className="pkg-version">{pkg.version}</span>
                    </div>
                    <button
                      className="remove-btn"
                      disabled={isJobActive}
                      onClick={() => handleRemove(pkg.name)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add form */}
          <div>
            <div className="section-title">Add Library</div>
            <div className="add-form">
              <div className="field name-field">
                <label>Package name</label>
                <input
                  type="text"
                  placeholder="e.g. sharp"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isJobActive}
                />
              </div>
              <div className="field version-field">
                <label>Version</label>
                <input
                  type="text"
                  placeholder="latest"
                  value={addVersion}
                  onChange={(e) => setAddVersion(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isJobActive}
                />
              </div>
              <button
                className="add-btn"
                disabled={isJobActive || !addName.trim()}
                onClick={handleInstall}
              >
                Install
              </button>
            </div>
          </div>

          {/* Job status */}
          {activeJob ? (
            <div>
              <div className="section-title">
                {activeJob.type === 'install' ? 'Install' : 'Remove'} Job
              </div>

              {isJobActive ? (
                <div className="status-area running">
                  Status: {activeJob.status}...
                </div>
              ) : null}

              {jobResult ? (
                <div className={`status-area ${jobResult.status}`}>
                  {jobResult.status === 'succeeded' ? 'Completed successfully' : `Failed: ${jobResult.error ?? 'Unknown error'}`}
                </div>
              ) : null}

              {logs.length > 0 ? (
                <div className="log-panel" ref={logPanelRef}>
                  {logs.map((line, i) => (
                    <div
                      key={i}
                      className={`log-line${line.startsWith('ERROR:') ? ' error' : ''}`}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
