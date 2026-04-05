import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import {
  cancelJob,
  fetchJob,
  fetchRuntimeLibraries,
  installPackages,
  removePackages,
  streamJobLogs,
  type JobState,
  type RuntimeLibrariesState,
  type RuntimeLibraryJobLogEntry,
  type SSEEvent,
} from './runtimeLibrariesApi';

export function useRuntimeLibrariesModalState(isOpen: boolean) {
  const STALLED_THRESHOLD_MS = 45_000;
  const [state, setState] = useState<RuntimeLibrariesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addName, setAddName] = useState('');
  const [addVersion, setAddVersion] = useState('latest');
  const [showInstallForm, setShowInstallForm] = useState(false);
  const [activeJob, setActiveJob] = useState<JobState | null>(null);
  const [logEntries, setLogEntries] = useState<RuntimeLibraryJobLogEntry[]>([]);
  const [jobResult, setJobResult] = useState<{
    status: 'succeeded' | 'failed';
    error?: string;
  } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [cancellingJob, setCancellingJob] = useState(false);

  const logPanelRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const wasOpenRef = useRef(false);
  const trackedJobIdRef = useRef<string | null>(null);
  const retainedJobRef = useRef<JobState | null>(null);

  const mergeLogEntries = useCallback((
    previous: RuntimeLibraryJobLogEntry[],
    incoming: RuntimeLibraryJobLogEntry[],
  ) => {
    if (incoming.length === 0) {
      return previous;
    }

    const seen = new Set(previous.map((entry) => `${entry.createdAt}\u0000${entry.source}\u0000${entry.message}`));
    const merged = [...previous];

    for (const entry of incoming) {
      const key = `${entry.createdAt}\u0000${entry.source}\u0000${entry.message}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(entry);
    }

    return merged;
  }, []);

  const applyJobState = useCallback((job: JobState | null) => {
    setActiveJob(job);
    retainedJobRef.current = job;
    if (job) {
      trackedJobIdRef.current = job.id;
      setLogEntries((prev) => mergeLogEntries([], job.logEntries ?? prev));
      return;
    }

    trackedJobIdRef.current = null;
    setLogEntries([]);
  }, [mergeLogEntries]);

  const displayedJob = activeJob ?? retainedJobRef.current;
  const isJobActive = displayedJob != null &&
    displayedJob.status !== 'succeeded' &&
    displayedJob.status !== 'failed';

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchRuntimeLibraries();
      setState(data);

      if (data.activeJob && data.activeJob.status !== 'succeeded' && data.activeJob.status !== 'failed') {
        applyJobState(data.activeJob);
        startStreaming(data.activeJob.id);
      } else {
        applyJobState(data.activeJob ?? retainedJobRef.current ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [applyJobState]);

  const refreshActiveStateSilently = useCallback(async (jobId?: string) => {
    try {
      const trackedJobId = jobId ?? trackedJobIdRef.current ?? undefined;
      const [data, currentJob] = await Promise.all([
        fetchRuntimeLibraries(),
        trackedJobId ? fetchJob(trackedJobId).catch(() => null) : Promise.resolve(null),
      ]);
      setState(data);
      if (currentJob) {
        applyJobState(currentJob);
        if (currentJob.status === 'succeeded' || currentJob.status === 'failed') {
          setJobResult({ status: currentJob.status, error: currentJob.error });
          setCancellingJob(false);
          if (!data.activeJob) {
            eventSourceRef.current?.close();
          }
        }
      } else if (data.activeJob) {
        applyJobState(data.activeJob);
      } else {
        applyJobState(retainedJobRef.current ?? null);
      }
      setError(null);
    } catch {
      // keep existing UI state on background refresh failures
    }
  }, [applyJobState]);

  const startStreaming = useCallback((jobId: string) => {
    eventSourceRef.current?.close();

    const source = streamJobLogs(
      jobId,
      (event: SSEEvent) => {
        if (event.type === 'log' && event.message) {
          const entry: RuntimeLibraryJobLogEntry = {
            message: event.message,
            createdAt: event.createdAt ?? new Date().toISOString(),
            source: event.source ?? 'system',
          };
          setLogEntries((prev) => mergeLogEntries(prev, [entry]));
          setActiveJob((prev) => {
            if (!prev && !retainedJobRef.current) {
              return prev;
            }

            const base = prev ?? retainedJobRef.current!;
            const mergedEntries = mergeLogEntries(base.logEntries, [entry]);
            const next = {
              ...base,
              logs: mergedEntries.map((logEntry) => logEntry.message),
              logEntries: mergedEntries,
              lastProgressAt: entry.createdAt,
            };
            retainedJobRef.current = next;
            return next;
          });
        }
        if (event.type === 'status' && event.status) {
          setActiveJob((prev) => {
            if (!prev && !retainedJobRef.current) {
              return prev;
            }

            const base = prev ?? retainedJobRef.current!;
            const next = {
              ...base,
              status: event.status,
              lastProgressAt: event.createdAt ?? base.lastProgressAt,
              cancelRequestedAt: event.cancelRequestedAt ?? base.cancelRequestedAt,
            };
            retainedJobRef.current = next;
            return next;
          });
        }
        if (event.type === 'done') {
          setJobResult({ status: event.status as 'succeeded' | 'failed', error: event.error });
          setCancellingJob(false);
          trackedJobIdRef.current = jobId;
          setActiveJob((prev) => {
            if (!prev && !retainedJobRef.current) {
              return prev;
            }

            const base = prev ?? retainedJobRef.current!;
            const next = {
              ...base,
              status: event.status as 'succeeded' | 'failed',
              error: event.error ?? base.error,
              lastProgressAt: event.createdAt ?? base.lastProgressAt,
              cancelRequestedAt: event.cancelRequestedAt ?? base.cancelRequestedAt,
            };
            retainedJobRef.current = next;
            return next;
          });
          void refresh();
        }
      },
      () => {
        void refreshActiveStateSilently(jobId);
      },
    );

    eventSourceRef.current = source;
  }, [mergeLogEntries, refresh, refreshActiveStateSilently]);

  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      void refresh();
    } else if (wasOpenRef.current) {
      eventSourceRef.current?.close();
      setActiveJob(null);
      setLogEntries([]);
      setJobResult(null);
      setShowInstallForm(false);
      setCancellingJob(false);
      trackedJobIdRef.current = null;
      retainedJobRef.current = null;
      wasOpenRef.current = false;
    }

    return () => {
      eventSourceRef.current?.close();
    };
  }, [isOpen, refresh]);

  useEffect(() => {
    if (logPanelRef.current) {
      logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
    }
  }, [logEntries]);

  useEffect(() => {
    if (!isOpen || !isJobActive) {
      return;
    }

    const tick = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => clearInterval(tick);
  }, [isJobActive, isOpen]);

  useEffect(() => {
    if (!isOpen || !isJobActive) {
      return;
    }

    const interval = setInterval(() => {
      void refreshActiveStateSilently(activeJob?.id);
    }, 10_000);
    return () => clearInterval(interval);
  }, [activeJob?.id, isJobActive, isOpen, refreshActiveStateSilently]);

  const handleInstall = useCallback(async () => {
    if (!addName.trim()) {
      return;
    }

    try {
      setError(null);
      setJobResult(null);
      const job = await installPackages([{ name: addName.trim(), version: addVersion.trim() || 'latest' }]);
      applyJobState(job);
      startStreaming(job.id);
      setAddName('');
      setAddVersion('latest');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [addName, addVersion, applyJobState, startStreaming]);

  const handleRemove = useCallback(async (packageName: string) => {
    try {
      setError(null);
      setJobResult(null);
      const job = await removePackages([packageName]);
      applyJobState(job);
      startStreaming(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [applyJobState, startStreaming]);

  const handleCancel = useCallback(async () => {
    if (!displayedJob || !isJobActive || cancellingJob) {
      return;
    }

    try {
      setCancellingJob(true);
      setError(null);
      const job = await cancelJob(displayedJob.id);
      applyJobState(job);
      if (job.status === 'failed' || job.status === 'succeeded') {
        setJobResult({ status: job.status, error: job.error });
        setCancellingJob(false);
        void refresh();
      }
    } catch (err) {
      setCancellingJob(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [applyJobState, cancellingJob, displayedJob, isJobActive, refresh]);

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isJobActive && addName.trim()) {
      e.preventDefault();
      void handleInstall();
    }
  }, [addName, handleInstall, isJobActive]);

  const packages = state ? Object.values(state.packages) : [];
  const lastProgressAtMs = displayedJob?.lastProgressAt ? new Date(displayedJob.lastProgressAt).getTime() : null;
  const isStalled = isJobActive && lastProgressAtMs != null && nowMs - lastProgressAtMs > STALLED_THRESHOLD_MS;

  return {
    state,
    loading,
    error,
    addName,
    addVersion,
    showInstallForm,
    displayedJob,
    logEntries,
    jobResult,
    cancellingJob,
    isJobActive,
    isStalled,
    nowMs,
    packages,
    logPanelRef,
    setAddName,
    setAddVersion,
    setShowInstallForm,
    handleInstall,
    handleRemove,
    handleCancel,
    handleKeyDown,
  };
}
