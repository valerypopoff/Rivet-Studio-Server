#!/bin/sh
set -eu

. /opt/rivet/lib/load-env.sh

load_optional_dotenv /vault/dotenv
maybe_export_database_connection_string
append_proxy_bootstrap_node_options

export PORT="${PORT:-21889}"
export HOME="${HOME:-/home/rivet}"
export RIVET_RUNTIME_LIBRARIES_ROOT="${RIVET_RUNTIME_LIBRARIES_ROOT:-/data/runtime-libraries}"
export RIVET_RUNTIME_PROCESS_ROLE="${RIVET_RUNTIME_PROCESS_ROLE:-executor}"

exec node /app/executor-bundle.cjs --port "${PORT}"
