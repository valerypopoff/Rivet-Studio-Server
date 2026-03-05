// Override for rivet/packages/app/src/hooks/useExecutorSidecar.ts
// No-op: executor runs as a Docker service in hosted mode

export function useExecutorSidecar(_options: { enabled?: boolean } = {}) {
  // no-op: executor is a separate Docker service
}
