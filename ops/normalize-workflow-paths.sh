normalize_path() {
  value="$1"
  fallback="$2"
  trimmed=$(printf '%s' "${value}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')

  if [ -z "$trimmed" ]; then
    trimmed="$fallback"
  fi

  case "$trimmed" in
    /*) ;;
    *) trimmed="/$trimmed" ;;
  esac

  normalized=$(printf '%s' "$trimmed" | sed 's:/*$::')

  if [ -z "$normalized" ]; then
    normalized="$fallback"
  fi

  printf '%s' "$normalized"
}

export RIVET_PUBLISHED_WORKFLOWS_BASE_PATH="$(normalize_path "${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-}" "/workflows")"
export RIVET_LATEST_WORKFLOWS_BASE_PATH="$(normalize_path "${RIVET_LATEST_WORKFLOWS_BASE_PATH:-}" "/workflows-last")"

exec /docker-entrypoint.sh nginx -g 'daemon off;'
