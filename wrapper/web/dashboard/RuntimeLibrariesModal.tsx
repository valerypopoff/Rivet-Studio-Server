import Button, { LoadingButton } from '@atlaskit/button';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import TextField from '@atlaskit/textfield';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
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

export const RuntimeLibrariesModal: FC<RuntimeLibrariesModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [state, setState] = useState<RuntimeLibrariesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add form
  const [addName, setAddName] = useState('');
  const [addVersion, setAddVersion] = useState('latest');
  const [showInstallForm, setShowInstallForm] = useState(false);

  // Job tracking
  const [activeJob, setActiveJob] = useState<JobState | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [jobResult, setJobResult] = useState<{
    status: 'succeeded' | 'failed';
    error?: string;
  } | null>(null);

  const logPanelRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const dismissedJobIdRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);

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
      if (
        data.activeJob &&
        data.activeJob.id !== dismissedJobIdRef.current &&
        data.activeJob.status !== 'succeeded' &&
        data.activeJob.status !== 'failed'
      ) {
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
      wasOpenRef.current = true;
      refresh();
    } else if (wasOpenRef.current) {
      dismissedJobIdRef.current = activeJob?.id ?? null;
      eventSourceRef.current?.close();
      setActiveJob(null);
      setLogs([]);
      setJobResult(null);
      setShowInstallForm(false);
      wasOpenRef.current = false;
    }

    return () => {
      eventSourceRef.current?.close();
    };
  }, [activeJob?.id, isOpen, refresh]);

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
      dismissedJobIdRef.current = null;
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
      dismissedJobIdRef.current = null;
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

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isJobActive && addName.trim()) {
      e.preventDefault();
      void handleInstall();
    }
  }, [handleInstall, isJobActive, addName]);

  if (!isOpen) return null;

  const packages = state ? Object.values(state.packages) : [];

  return (
    <ModalTransition>
      <ModalDialog
        testId="runtime-libraries-modal"
        width="medium"
        label="Runtime libraries"
        onClose={onClose}
      >
        <ModalBody>
          <div className="project-settings-modal-shell runtime-libraries-shell">
            <div className="project-settings-modal-header-row runtime-libraries-header-row">
              <div className="project-settings-modal-heading runtime-libraries-heading">
                <div className="project-settings-modal-title runtime-libraries-title">Runtime libraries</div>
                <div className="runtime-libraries-help runtime-libraries-header-help">
                  Installed runtime libraries are available to Code nodes
                </div>
              </div>
              <button
                type="button"
                className="project-settings-close-button"
                onClick={onClose}
                aria-label="Close runtime libraries"
              >
                ×
              </button>
            </div>

            <div className="project-settings-modal-content runtime-libraries-content">
              {error ? (
                <div className="project-settings-error runtime-libraries-status failed">{error}</div>
              ) : null}

              {!loading && packages.length > 0 ? (
                <>
                  <div className="project-settings-field runtime-libraries-section">
                    <div className="runtime-libraries-installed-list">
                      {packages.map((pkg) => (
                        <div key={pkg.name} className="runtime-libraries-installed-item">
                          <div className="runtime-libraries-package-info">
                            <span className="runtime-libraries-package-name">{`${pkg.name}: ${pkg.version}`}</span>
                          </div>
                          <Button
                            appearance="subtle"
                            spacing="compact"
                            className="runtime-libraries-remove-button project-settings-secondary-button button-size-s"
                            isDisabled={isJobActive}
                            onClick={() => void handleRemove(pkg.name)}
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                  {showInstallForm ? <div className="runtime-libraries-section-divider" aria-hidden="true" /> : null}
                </>
              ) : null}

              {showInstallForm ? (
                <div className="project-settings-field runtime-libraries-section">
                  <label className="project-settings-label" htmlFor="runtime-library-package-name">
                    Install library
                  </label>
                  <div className="runtime-libraries-form-grid">
                    <div className="project-settings-field">
                      <TextField
                        id="runtime-library-package-name"
                        className="project-settings-input text-field-size-l"
                        value={addName}
                        onChange={(e) => setAddName(e.currentTarget.value)}
                        onKeyDown={handleKeyDown}
                        isDisabled={isJobActive}
                        placeholder="NPM package name"
                        spellCheck={false}
                      />
                    </div>
                    <div className="project-settings-field">
                      <TextField
                        id="runtime-library-package-version"
                        className="project-settings-input text-field-size-l"
                        value={addVersion}
                        onChange={(e) => setAddVersion(e.currentTarget.value)}
                        onKeyDown={handleKeyDown}
                        isDisabled={isJobActive}
                        placeholder="version"
                        spellCheck={false}
                      />
                    </div>
                    <div className="runtime-libraries-form-action">
                      <LoadingButton
                        appearance="primary"
                        className="project-settings-primary-button runtime-libraries-install-button button-size-l"
                        onClick={() => void handleInstall()}
                        isDisabled={isJobActive || !addName.trim()}
                        isLoading={isJobActive && activeJob?.type === 'install'}
                      >
                        Install
                      </LoadingButton>
                    </div>
                  </div>
                </div>
              ) : (
                <Button
                  appearance="primary"
                  className="runtime-libraries-add-button button-size-l"
                  onClick={() => setShowInstallForm(true)}
                >
                  Add library...
                </Button>
              )}

              {activeJob ? (
                <div className="project-settings-field runtime-libraries-section">
                  <label className="project-settings-label">
                    {activeJob.type === 'install' ? 'Install job' : 'Remove job'}
                  </label>

                  {isJobActive ? (
                    <div className="runtime-libraries-status running">
                      Status: {activeJob.status}...
                    </div>
                  ) : null}

                  {jobResult ? (
                    <div className={`runtime-libraries-status ${jobResult.status}`}>
                      {jobResult.status === 'succeeded' ? 'Completed successfully' : `Failed: ${jobResult.error ?? 'Unknown error'}`}
                    </div>
                  ) : null}

                  {logs.length > 0 ? (
                    <div className="runtime-libraries-log-panel" ref={logPanelRef}>
                      {logs.map((line, i) => (
                        <div
                          key={i}
                          className={`runtime-libraries-log-line${line.startsWith('ERROR:') ? ' error' : ''}`}
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
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
