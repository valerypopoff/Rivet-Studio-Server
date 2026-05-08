import type { ProjectId } from '@valerypopoff/rivet2-core';
import {
  clearProjectContextState as deleteStoredProjectContextState,
  projectContextState,
} from '../../../../rivet/packages/app/src/state/savedGraphs';

export * from '../../../../rivet/packages/app/src/state/savedGraphs';

export function clearProjectContextState(projectId: ProjectId): void {
  // Hosted tab close is not project deletion; editor-owned context must survive reopen.
  projectContextState.remove(projectId);
}

export function deleteHostedProjectContextState(projectId: ProjectId): void {
  deleteStoredProjectContextState(projectId);
}
