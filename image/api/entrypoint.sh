#!/bin/sh
set -eu

. /opt/rivet/lib/load-env.sh

load_optional_dotenv /vault/dotenv
maybe_export_database_connection_string
append_proxy_bootstrap_node_options

export PORT="${PORT:-8080}"
export RIVET_WORKSPACE_ROOT="${RIVET_WORKSPACE_ROOT:-/workspace}"
export RIVET_WORKFLOWS_ROOT="${RIVET_WORKFLOWS_ROOT:-/workflows}"
export RIVET_APP_DATA_ROOT="${RIVET_APP_DATA_ROOT:-/data/rivet-app}"
export RIVET_RUNTIME_LIBRARIES_ROOT="${RIVET_RUNTIME_LIBRARIES_ROOT:-/data/runtime-libraries}"
export RIVET_RUNTIME_PROCESS_ROLE="${RIVET_RUNTIME_PROCESS_ROLE:-api}"

exec node /app/wrapper/api/dist/api/src/server.js
