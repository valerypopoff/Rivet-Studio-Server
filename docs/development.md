# Development

## Main paths

- `npm run prod` starts the production-style Docker stack
- `npm run dev` starts the Docker-based dev stack
- `npm run dev:local` starts local API, web, and executor processes
- `npm run dev:recreate` rebuilds and recreates the Docker dev stack
- `npm run dev:down` stops the Docker dev stack

## Shared env loading

Root launcher scripts load `.env` through `scripts/lib/dev-env.mjs`.

That file is the single place for:

- default `RIVET_WORKSPACE_ROOT`
- default `RIVET_APP_DATA_ROOT`
- default `RIVET_RUNTIME_LIBRARIES_ROOT`
- host-path normalization for Docker bind mounts

## Recording-storage notes

Workflow recordings now use two persistence locations:

- compressed replay artifacts under the workflow root (`.recordings/`)
- a SQLite index under `RIVET_APP_DATA_ROOT` (`recordings.sqlite`)

For local non-Docker API execution, that means the runtime must support `node:sqlite` (Node 24+). If your host Node version is older, use the Docker dev stack instead of `npm run dev:local`.

## Docker dev behavior

The Docker dev launchers rebuild the relevant images automatically before starting, so runtime changes such as Node version bumps or new API dependencies are picked up without a manual Docker build step.

## Source of truth

- authored source lives under `wrapper/`, `ops/`, `scripts/`, and `docs/`
- generated build output should not be treated as authored source

## Safe refactor workflow

1. run `npm --prefix wrapper/api test`
2. run `npm --prefix wrapper/api run build`
3. run `npm --prefix wrapper/web run build`
