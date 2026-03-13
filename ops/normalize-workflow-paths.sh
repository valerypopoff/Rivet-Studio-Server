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

build_host_regex() {
  value="$1"
  api_key="${2:-}"
  trimmed=$(printf '%s' "${value}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  trimmed_api_key=$(printf '%s' "${api_key}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')

  if [ -z "$trimmed" ] || [ -z "$trimmed_api_key" ]; then
    printf 'a^'
    return
  fi

  old_ifs=$IFS
  IFS=','
  set -- $trimmed
  IFS=$old_ifs

  pattern=''
  for host in "$@"; do
    host_trimmed=$(printf '%s' "${host}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    if [ -z "$host_trimmed" ]; then
      continue
    fi

    escaped_host=$(printf '%s' "${host_trimmed}" | sed 's/[][(){}.^$+*?|\\-]/\\&/g')
    if [ -z "$pattern" ]; then
      pattern="$escaped_host"
    else
      pattern="${pattern}|${escaped_host}"
    fi
  done

  if [ -z "$pattern" ]; then
    printf 'a^'
    return
  fi

  printf '^(%s)$' "$pattern"
}

export RIVET_PUBLISHED_WORKFLOWS_BASE_PATH="$(normalize_path "${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-}" "/workflows")"
export RIVET_LATEST_WORKFLOWS_BASE_PATH="$(normalize_path "${RIVET_LATEST_WORKFLOWS_BASE_PATH:-}" "/workflows-last")"
export RIVET_UI_TOKEN_FREE_HOSTS_REGEX="$(build_host_regex "${RIVET_UI_TOKEN_FREE_HOSTS:-}" "${RIVET_ENDPOINT_API_KEY:-}")"

exec /docker-entrypoint.sh nginx -g 'daemon off;'
