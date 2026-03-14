# Development

## Main paths

- `npm run prod` starts the production-style Docker stack
- `npm run dev` starts the Docker-based dev stack
- `npm run dev:local` starts local API, web, and executor processes

## Shared env loading

Root launcher scripts load `.env` through `scripts/lib/dev-env.mjs`.

That file is the single place for:

- default `RIVET_WORKSPACE_ROOT`
- default `RIVET_APP_DATA_ROOT`
- default `RIVET_RUNTIME_LIBRARIES_ROOT`
- host-path normalization for Docker bind mounts

## Source of truth

- authored source lives under `wrapper/`, `ops/`, `scripts/`, and `docs/`
- generated build output should not be treated as authored source

## Safe refactor workflow

1. run `npm --prefix wrapper/api test`
2. run `npm --prefix wrapper/api run build`
3. run `npm --prefix wrapper/web run build`
