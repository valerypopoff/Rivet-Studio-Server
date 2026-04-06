#!/bin/sh
set -eu

load_optional_dotenv() {
  dotenv_path="${1:-/vault/dotenv}"
  dotenv_file_name="${RIVET_VAULT_DOTENV_FILE_NAME:-dotenv}"

  if [ ! -f "$dotenv_path" ] && [ -f "/vault/secrets/${dotenv_file_name}" ]; then
    dotenv_path="/vault/secrets/${dotenv_file_name}"
  fi

  if [ ! -f "$dotenv_path" ]; then
    return
  fi

  set -a
  # shellcheck disable=SC1090
  . "$dotenv_path"
  set +a
}

maybe_export_database_connection_string() {
  if [ -n "${RIVET_DATABASE_CONNECTION_STRING:-}" ]; then
    return
  fi

  if ! output="$(node /opt/rivet/lib/build-db-connection.mjs)"; then
    exit 1
  fi

  if [ -n "$output" ]; then
    export RIVET_DATABASE_CONNECTION_STRING="$output"
  fi
}

append_proxy_bootstrap_node_options() {
  bootstrap_flag="--import=/opt/proxy-bootstrap/bootstrap.mjs"

  case " ${NODE_OPTIONS:-} " in
    *" ${bootstrap_flag} "*) ;;
    *)
      export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }${bootstrap_flag}"
      ;;
  esac
}
