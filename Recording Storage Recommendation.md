# Recording Storage Recommendation

## Summary

Your judgment is directionally right, but the main problem is not "files vs database." The main problems in the current design are:

- every run writes multiple uncompressed artifacts to disk
- the recorder is configured in high-volume mode (`includePartialOutputs=true`, `includeTrace=true`)
- the current listing path is scan-heavy and returns all recordings to the UI
- there is no retention, quota, or archival policy
- the current replay bundle duplicates project state per run

A database inside Docker is not the primary fix. A database still stores bytes on disk, and if it is not backed by a persistent volume it is actually worse than the current host-mounted files. For this stack, I would not put the large recording blobs into a database first. I would use a hybrid design:

1. keep large artifacts as compressed blobs on persistent storage
2. add a small metadata index in SQLite
3. add retention and size controls
4. only move to Postgres + object storage if you later need multi-instance or cross-host scale

## Observed Current State

Current implementation facts from the repo:

- recordings are stored under the workflow root, which in Docker is backed by `RIVET_WORKFLOWS_HOST_PATH`
- each run currently stores `recording.rivet-recording`, `replay.rivet-project`, optional `replay.rivet-data`, and `metadata.json`
- the API currently scans filesystem state to build the recordings list
- the dashboard currently fetches recording metadata eagerly and paginates client-side
- workflow execution currently enables both `includePartialOutputs` and `includeTrace`
- dataset snapshots currently export all datasets for the project, not only data proven necessary for replay

That means the current design is simple and workable at low volume, but it will become expensive in disk usage and slow in listing/query paths once run counts get large.

## Assessment

The correct conclusion is:

- yes, you should be worried about uncontrolled disk growth
- no, moving everything into a database is not the best first step
- yes, compression is worth doing
- yes, query/index metadata belongs in a database sooner than the blobs do
- no, "inside Docker" is not a durability strategy unless it is backed by a persistent host path or volume

If I had to choose one immediate direction, it would be:
keep blobs on disk, compress them, reduce verbosity, and add retention.
If I had to choose one medium-term direction, it would be:
add SQLite metadata indexing and server-side pagination/filtering.

## Recommended Design

## Phase 1: Fix storage economics without changing the storage model

Keep recordings as files on persistent storage, but change what gets written and how.

### Decisions

- Store blobs under the existing workflow storage root.
- Compress all large artifacts with `gzip`.
- Keep `metadata.json` uncompressed for cheap inspection and recovery.
- Turn recorder verbosity down by default in production.
- Make dataset snapshotting configurable and default it off.

### Exact storage model

Per run, store:

- `metadata.json`
- `recording.rivet-recording.gz`
- `replay.rivet-project.gz`
- `replay.rivet-data.gz` only when dataset snapshotting is enabled

### Compression choice

Use `gzip`, not Brotli, for the first version.

Why:
- built into Node 20
- universal tooling support
- cheap enough CPU cost
- simple recovery/debugging story
- easy server-side decompression

Use `gzip` level `4` as the default. It is a good speed/size tradeoff for high write volume.

### Recording verbosity defaults

Set production defaults to:

- `includePartialOutputs=false`
- `includeTrace=false`

Keep both configurable. These two flags are likely a bigger size win than the database question.

### Dataset snapshot policy

Make dataset capture configurable:

- `none` as the default
- `all` as the compatibility mode

Reason:
replay itself is driven by recorded events, so full dataset export is not always necessary for debugging playback. Exporting all project datasets per run is the biggest worst-case storage risk in the current design.

### Retention and quota policy

Add all of these:

- max age
- max runs per workflow
- optional total storage cap
- optional failed-runs-only retention override

Default policy:

- keep `14` days
- keep at most `5000` runs per workflow
- no global byte cap by default
- failed runs are not treated specially in v1

Run cleanup in two places:

- after successful recording persistence, best-effort
- on API startup, best-effort

## Phase 2: Add a metadata database, but not blob storage in the database

Add SQLite for indexing and querying metadata only.

### Why SQLite

For the current product shape, SQLite is the right database:

- there is no existing database service in the stack
- this is a single-host Docker deployment today
- query volume is small compared to blob volume
- operational cost is low
- you can keep it on a persistent mount

Do not add Postgres first.

### Where it lives

Persist it on durable storage, not container-local ephemeral storage.

Recommended location:

- `/data/rivet-app/recordings.sqlite` in Docker
- repo `.data` equivalent in local dev

### What goes into SQLite

Create three tables:

1. `recording_workflows`
   Columns:
   `workflow_id`, `source_project_metadata_id`, `source_project_path`, `source_project_relative_path`, `source_project_name`, `latest_known_project_status`, `latest_known_endpoint_name`, `latest_run_at`, `total_runs`, `failed_runs`, `created_at`, `updated_at`

2. `recording_runs`
   Columns:
   `recording_id`, `workflow_id`, `created_at`, `run_kind`, `status`, `duration_ms`, `endpoint_name_at_execution`, `error_message`, `recording_blob_path`, `replay_project_blob_path`, `replay_dataset_blob_path`, `recording_uncompressed_bytes`, `recording_compressed_bytes`, `project_uncompressed_bytes`, `project_compressed_bytes`, `dataset_uncompressed_bytes`, `dataset_compressed_bytes`, `created_by_version`

3. `recording_storage_state`
   Columns:
   `key`, `value`
   Use this for cleanup cursors, schema version, and migration markers.

Indexes:

- `recording_runs(workflow_id, created_at desc)`
- `recording_runs(status, created_at desc)`
- `recording_runs(created_at desc)`
- `recording_workflows(latest_run_at desc)`

### What stays out of SQLite

Do not store these as BLOB columns:

- serialized `.rivet-recording`
- replay project snapshot
- replay dataset snapshot

Reason:
that makes the database bigger, slower to back up, and harder to manage. The DB is for lookup, not bulk artifact storage.

## Phase 3: Fix query scalability and decouple the UI from filesystem scanning

Move the recordings UI to server-side filtering and pagination.

### API changes

Keep the current workflow tree API unchanged.

Replace the recordings API contract with these endpoints:

- `GET /api/workflows/recordings/workflows`
  Returns workflow summaries only.

- `GET /api/workflows/recordings/workflows/:workflowId/runs?page=1&pageSize=20&status=all|failed`
  Returns paginated run summaries for one workflow.

- `GET /api/workflows/recordings/:recordingId/recording`
  Streams the decompressed `.rivet-recording` payload.

- `GET /api/workflows/recordings/:recordingId/replay-project`
  Streams the decompressed replay project payload.

- `GET /api/workflows/recordings/:recordingId/replay-dataset`
  Streams the decompressed replay dataset payload when present.

### Shared type changes

Deprecate path-based recording access in the shared types.

Current path-coupled fields should be removed from the UI-facing contract:

- `recordingPath`
- `replayProjectPath`

Replace with opaque IDs and summary fields.

Recommended types:

```ts
type WorkflowRecordingWorkflowSummary = {
  workflowId: string;
  sourceProjectMetadataId: string;
  projectName: string;
  projectRelativePath: string;
  projectStatus: 'unpublished' | 'published' | 'unpublished_changes';
  endpointName: string;
  latestRunAt?: string;
  totalRuns: number;
  failedRuns: number;
};

type WorkflowRecordingRunSummary = {
  id: string;
  workflowId: string;
  createdAt: string;
  runKind: 'published' | 'latest';
  status: 'succeeded' | 'failed';
  durationMs: number;
  endpointNameAtExecution: string;
  errorMessage?: string;
  hasReplayDataset: boolean;
  recordingCompressedBytes: number;
  recordingUncompressedBytes: number;
};
```

### Editor bridge change

Change `open-recording` to carry `recordingId` instead of raw filesystem paths.

Recommended command:

```ts
{ type: 'open-recording'; recordingId: string; replaceCurrent: boolean }
```

Reason:
the current path-based contract ties the whole feature to filesystem storage and makes later migration harder.

## Phase 4: Only then consider deduplication of replay project snapshots

This is a second-order optimization, not the first one.

### Why it is valuable

Published workflows often run many times without changing. Storing a full replay project snapshot for every run wastes space.

### Why it is not phase 1

Today replay projects get a fresh project ID per saved bundle so they do not collide with the currently open workflow. That means identical project state is intentionally made non-identical on disk. True deduplication requires changing the replay-open flow.

### Decision

Do not dedupe replay snapshots until the editor is opened by `recordingId` and fetched through API endpoints.

Then:

- store canonical compressed replay snapshots by content hash
- rewrite the project ID at read/open time so the editor still gets a collision-free in-memory project
- keep run rows pointing to the canonical snapshot hash

This is a good optimization, but it should follow the API decoupling.

## Phase 5: Multi-node future path

If later you need multiple API instances or shared storage across hosts, swap only the metadata and blob backing stores:

- replace SQLite with Postgres
- replace local blob storage with S3 or MinIO
- keep the same `recordingId`-based API contract

That is the point where a "real DB" becomes the right move.

## Configuration Additions

Add these env vars:

- `RIVET_RECORDINGS_ENABLED=true`
- `RIVET_RECORDINGS_COMPRESS=gzip`
- `RIVET_RECORDINGS_GZIP_LEVEL=4`
- `RIVET_RECORDINGS_INCLUDE_PARTIAL_OUTPUTS=false`
- `RIVET_RECORDINGS_INCLUDE_TRACE=false`
- `RIVET_RECORDINGS_DATASET_MODE=none`
- `RIVET_RECORDINGS_RETENTION_DAYS=14`
- `RIVET_RECORDINGS_MAX_RUNS_PER_WORKFLOW=5000`
- `RIVET_RECORDINGS_MAX_TOTAL_BYTES=0`

Interpret `RIVET_RECORDINGS_MAX_TOTAL_BYTES=0` as disabled.

Do not add a separate recordings host-path env var yet. Keep recordings under the workflow root until there is a strong operational reason to split them.

## Testing And Acceptance Criteria

### Storage behavior

- successful published runs create compressed artifacts and metadata rows
- failed runs also create compressed artifacts and metadata rows
- `includePartialOutputs=false` and `includeTrace=false` reduce artifact size without breaking replay
- dataset mode `none` still allows recording playback to work

### Query behavior

- workflows endpoint returns summaries without loading all run records into memory
- runs endpoint paginates on the server
- failed-only filtering is server-side
- sorting is by most recent run descending

### Cleanup behavior

- runs older than retention are removed
- runs over the per-workflow cap are removed oldest-first
- cleanup does not delete newer runs while older runs remain
- SQLite rows and blob files stay consistent after cleanup

### Compatibility behavior

- old uncompressed bundles are still readable during migration
- existing recordings remain openable after the new index is introduced
- missing blob files degrade gracefully as unavailable recordings, not fatal list failures

### Editor behavior

- `open-recording` by `recordingId` still opens the correct graph
- playback still works in hosted mode
- loading a recording still switches execution to browser replay mode

## Migration Plan

1. Keep current file layout readable.
2. Add SQLite and backfill it by scanning existing `.recordings` directories once.
3. Mark old bundles as `encoding=identity`.
4. New writes use compressed blobs and indexed metadata.
5. Switch the dashboard to paginated server APIs.
6. Switch the editor bridge from path-based recording open to `recordingId`.
7. Only after that, consider snapshot deduplication.

## Assumptions And Defaults

- This recommendation assumes a single-host self-hosted Docker deployment, which matches the current stack.
- This assumes recordings are for debugging and replay, not permanent audit/compliance retention.
- This assumes operational simplicity matters more than perfect horizontal scalability right now.
- This assumes it is acceptable to reduce default recording verbosity in production for size savings.
- This assumes you want to preserve the current replay UX, not redesign it around an external observability system.

## Bottom-Line Recommendation

I would not move the run blobs into a database first.

I would do this instead:

1. keep recordings as files on persistent storage
2. gzip them
3. disable partial outputs and trace by default
4. stop snapshotting datasets by default
5. add retention limits
6. add SQLite metadata indexing
7. move the UI to server-side pagination and filtering
8. only later move to Postgres + object storage if scale genuinely requires it

That gives you the biggest practical win with the least operational complexity.
