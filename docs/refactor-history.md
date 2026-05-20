# Refactor History

This document records intentional architecture and cleanup changes that future maintainers should understand before changing the same area again.

It is not a changelog. Keep entries focused on why a refactor happened, which ownership boundary changed, and which verification paths should be kept alive.

## 2026-05-19 - Published Version History

### Why

Publishing a workflow used to behave like a single mutable pointer: publishing overwrote the current stored snapshot, and unpublishing removed that snapshot. That made it impossible to inspect or recover earlier published states after repeated publishes.

The dashboard now treats each successful publish as a durable version-history entry. Project Settings exposes that history so an operator can download, preview, star, or restore notable published versions without reconnecting preview snapshots to the editable source project.

### Ownership

- Filesystem mode stores history under the workflow root's hidden `.published/` directory.
- Managed mode stores history in Postgres `workflow_published_versions`, pointing at immutable workflow revision blobs in object storage.
- The editor preview path is a wrapper-owned virtual path, not a real workflow project path.
- Published-version previews are detached and read-only; they must not become publishable workflow-tree projects.

### Important Details

- Every publish creates a new version id. The current published endpoint points at the newest version, while older versions stay in history.
- Starred state is durable server state, not browser state.
- Restore creates a new current history entry from the selected version instead of moving the current pointer back to an existing row.
- Restoring also replaces the saved live project/dataset with the selected snapshot so the project status remains coherent after restore.
- After restore, the dashboard sends `refresh-open-project-from-disk` for the restored path. If that project is active, the editor replaces the current tab from storage with `reloadFromDisk`; if it is open in a hidden tab, the editor clears that hidden tab's cached snapshot/session so switching back reloads from storage without stealing focus.
- Filesystem restore is not transactional, so the restore path backs up the live project/dataset before overwriting it and restores those bytes plus the old settings if a later published-artifact or settings write fails.
- Filesystem restore rejects a stored snapshot whose embedded project id no longer matches the history owner, which keeps a corrupt history artifact from changing the live workflow identity.
- Legacy already-published projects are backfilled into history before a later publish or unpublish can clear their only current pointer.
- In filesystem mode, the metadata filename is the authoritative version id. A mismatched internal JSON `id` is ignored so a stale metadata file cannot redirect actions to another snapshot.
- Duplicating or uploading a project creates a fresh workflow id, so published history does not copy across.
- Deleting a project deletes its published version history along with live project sidecars and recording history.

### Key Files

- `wrapper/api/src/routes/workflows/published-versions.ts`
- `wrapper/api/src/routes/workflows/workflow-mutations.ts`
- `wrapper/api/src/routes/workflows/managed/publication.ts`
- `wrapper/shared/workflow-types.ts`
- `wrapper/shared/editor-bridge.ts`
- `wrapper/web/dashboard/WorkflowPublishedVersionHistoryModal.tsx`
- `wrapper/web/io/HostedIOProvider.ts`
- `docs/workflow-publication.md`
- `docs/editor-bridge.md`

### Verification To Preserve

- API build: `npm --prefix wrapper/api run build`
- Web build: `npm --prefix wrapper/web run build`
- Filesystem history tests for multiple publishes, legacy backfill, star persistence, restore, and mismatched metadata ids
- Managed SQL/schema tests for `published_version_id`, `workflow_published_versions`, `is_starred`, and restore pointer updates
- Playwright Project Settings modal coverage for history visibility, pagination, star persistence, preview opening, and restore confirmation
