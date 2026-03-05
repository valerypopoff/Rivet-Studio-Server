// Override for rivet/packages/app/src/io/TauriIOProvider.ts
// Re-exports HostedIOProvider as TauriIOProvider so transitive imports work

export { HostedIOProvider as TauriIOProvider } from '../../io/HostedIOProvider.js';
