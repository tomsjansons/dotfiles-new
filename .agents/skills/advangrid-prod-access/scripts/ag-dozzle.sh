#!/usr/bin/env bash
# ag-dozzle — query the Advangrid production Dozzle instance over its HTTP API.
#
# Dozzle is a Docker log viewer. Its API is not documented, so this script
# encodes what the web UI itself does (verified against amir20/dozzle):
#
#   auth     POST /api/token, form fields `username` + `password`, sets an
#            HttpOnly `jwt` session cookie. Every other /api route needs it;
#            unauthenticated requests get 307 -> /login or 401. DELETE
#            /api/token logs out. Default is a session cookie; --auth-ttl
#            extends it.
#   state    GET /api/events/stream is Server-Sent Events. The first
#            `containers-changed` event carries the full host+container list as
#            JSON. That is how the UI enumerates containers — there is no
#            separate list endpoint.
#   logs     GET /api/hosts/{host}/containers/{id}/logs?stdout&stderr&everything
#            returns application/x-jsonl, or text/plain when the request sends
#            `Accept: text/plain`. The id goes in the path RAW: on Kubernetes it
#            is `namespace:pod:container`, and percent-encoding the colons makes
#            Dozzle 404. This deployment is K8s behind v11.0.1, where the
#            server-side from/to window returns nothing, so the script always
#            sends `everything` and slices by ts (epoch ms) locally.
#   follow   GET /api/hosts/{host}/containers/{id}/logs/stream (SSE).
#   download GET /api/containers/{host~id,...}/download?... returns a ZIP of
#            log files (needs the `download` role).
#
# Credentials come from the environment, populated by pass-cli (see
# ~/.zsh-secrets.map). The `jwt` cookie is cached in the runtime dir so repeat
# calls skip the login round-trip. Nothing secret is ever written to argv.
#
# Usage:
#   ag-dozzle containers [--all] [--json]
#   ag-dozzle find <name-substring>
#   ag-dozzle logs <name-substring|host~id> [options]
#   ag-dozzle follow <name-substring|host~id> [--grep RE] [--inverse]   (SSE frames)
#   ag-dozzle download <name-substring|host~id>... [options]
#   ag-dozzle api <GET-path>            authenticated GET, body to stdout
#   ag-dozzle logout
#
# logs/download options:
#   --since 30m            window ending now (default 15m; m/h/d suffixes)
#   --from ISO --to ISO    explicit RFC3339 window
#   --all                  no time window (every line the server retains)
#   --grep RE              server-side regex filter
#   --inverse              drop lines matching --grep instead of keeping them
#   --level error,warn     repeatable; keep only these levels
#   --json                 emit application/x-jsonl instead of text
#   --tail N               print only the last N lines (client-side)
#
# Environment:
#   ADV_PROD_DOZZLE_URL    base URL (default https://dozzle.advangrid.com)
#   ADV_PROD_DOZZLE_USER   login username (from pass-cli)
#   ADV_PROD_DOZZLE_PWD    login password (from pass-cli)
#   AG_DOZZLE_TIMEOUT      per-request seconds for auth/state (default 30)
#   AG_DOZZLE_LOG_TIMEOUT  per-request seconds for log fetches (default 120)
#   AG_FOLLOW_SECONDS      follow duration before the stream closes (default 60)
#   AG_DOWNLOAD_OUT        output path for `download` (default timestamped .zip)
set -euo pipefail

BASE="${ADV_PROD_DOZZLE_URL:-https://dozzle.advangrid.com}"
BASE="${BASE%/}"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}"
COOKIE_JAR="$RUNTIME_DIR/ag-dozzle-cookie.$(id -u)"
TIMEOUT="${AG_DOZZLE_TIMEOUT:-30}"
LOG_TIMEOUT="${AG_DOZZLE_LOG_TIMEOUT:-120}"

die() { printf 'ag-dozzle: %s\n' "$*" >&2; exit 1; }
have_jq() { command -v jq >/dev/null 2>&1; }

# .zsh-secrets caches every value in the per-uid kernel persistent keyring under
# `sec:<NAME>`. A fresh shell gets them exported, but a long-running agent (this
# one, say) inherited its environment before they existed and cannot refresh it.
# Fall back to the keyring so the helper works either way.
_from_keyring() {
  local name="$1" val
  command -v keyctl >/dev/null 2>&1 || return 1
  val=$(keyctl session - bash -c '
    pid=$(keyctl get_persistent @s "$EUID" 2>/dev/null) || exit 1
    kid=$(keyctl search "$pid" user "sec:$1" 2>/dev/null) || exit 1
    keyctl pipe "$kid" 2>/dev/null' _ "$name" 2>/dev/null) || return 1
  [[ -n "$val" ]] || return 1
  printf '%s' "$val"
}

# Export $1 from the environment, falling back to the keyring cache.
load_var() {
  local name="$1" val
  eval "val=\${$name:-}"
  if [[ -z "$val" ]]; then
    val=$(_from_keyring "$name") || return 1
    export "$name=$val"
  fi
  return 0
}

need_creds() {
  load_var ADV_PROD_DOZZLE_USER && load_var ADV_PROD_DOZZLE_PWD || die \
    "ADV_PROD_DOZZLE_USER / ADV_PROD_DOZZLE_PWD unavailable. Run 'sec-login' (or 'sec-api') in zsh first."
}

# --- auth ---------------------------------------------------------------------

_probe() {
  curl -sS -o /dev/null -w '%{http_code}' -m "$TIMEOUT" -b "$COOKIE_JAR" \
    "$BASE/api/version" 2>/dev/null || echo 000
}

do_login() {
  need_creds
  local ufile pfile code
  ufile=$(mktemp)
  pfile=$(mktemp)
  chmod 600 "$ufile" "$pfile"
  printf '%s' "$ADV_PROD_DOZZLE_USER" >"$ufile"
  printf '%s' "$ADV_PROD_DOZZLE_PWD" >"$pfile"
  code=$(curl -sS -o /dev/null -w '%{http_code}' -m "$TIMEOUT" \
    -c "$COOKIE_JAR" \
    --data-urlencode "username@$ufile" \
    --data-urlencode "password@$pfile" \
    "$BASE/api/token" 2>/dev/null) || code=000
  rm -f "$ufile" "$pfile"
  case "$code" in
    200) ;;
    401 | 403) die "login rejected (HTTP $code) — the ADV_PROD_DOZZLE_* credentials are wrong or rotated" ;;
    000) die "no response from $BASE" ;;
    *) die "login failed (HTTP $code) from $BASE — service or route problem, not credentials" ;;
  esac
  chmod 600 "$COOKIE_JAR" 2>/dev/null || true
}

ensure_login() {
  need_creds
  if [[ -s "$COOKIE_JAR" ]] && [[ "$(_probe)" == 200 ]]; then
    return 0
  fi
  do_login
}

# --- state snapshot -----------------------------------------------------------

# Echo the containers-changed JSON array from the events SSE stream.
#
# curl on an SSE stream only notices a closed reader when it next writes, and a
# quiet Dozzle stream never writes again, so letting awk `exit` on the matching
# event would leave curl parked until --max-time. Instead curl feeds a FIFO and
# we kill the reader/writer pair as soon as the event lands.
snapshot() {
  ensure_login
  local fifo tmpf cpid apid i raw
  fifo=$(mktemp -u)
  tmpf=$(mktemp)
  mkfifo "$fifo"
  curl -sSN -m "$TIMEOUT" -b "$COOKIE_JAR" "$BASE/api/events/stream" >"$fifo" 2>/dev/null &
  cpid=$!
  awk '/^event: containers-changed$/{f=1;next} f&&/^data: /{sub(/^data: /,"");print;exit}' <"$fifo" >"$tmpf" &
  apid=$!
  for (( i = 0; i < 200; i++ )); do
    [[ -s "$tmpf" ]] && break
    sleep 0.05
  done
  kill "$cpid" "$apid" 2>/dev/null || true
  wait "$cpid" 2>/dev/null || true
  wait "$apid" 2>/dev/null || true
  rm -f "$fifo"
  raw=$(cat "$tmpf")
  rm -f "$tmpf"
  [[ -n "$raw" ]] || die "Dozzle sent no containers-changed event (stream timed out?)"
  printf '%s' "$raw"
}

# Resolve an argument to "host<TAB>id<TAB>name". Accepts host~id, a full-length
# container id, or a case-insensitive name substring.
resolve() {
  local q="$1" json matches n
  if [[ "$q" == *~* ]]; then
    printf '%s\t%s\t%s\n' "${q%%~*}" "${q#*~}" "${q#*~}"
    return 0
  fi
  json=$(snapshot)
  have_jq || die "jq is required to resolve containers by name"
  matches=$(jq -r --arg q "$q" '
    .[] | select((.id == $q) or (((.name // "") | ascii_downcase) | contains($q | ascii_downcase)))
        | [(.host // ""), .id, (.name // "")] | @tsv' <<<"$json")
  n=$(printf '%s' "$matches" | grep -c . || true)
  if (( n == 0 )); then
    die "no container matches '$q'"
  fi
  if (( n > 1 )); then
    printf 'ag-dozzle: %d containers match %s:\n' "$n" "'$q'" >&2
    printf '%s\n' "$matches" | awk -F'\t' '{printf "  %s  %s\n", $1, $3}' >&2
    exit 1
  fi
  [[ -n "${matches%%$'\t'*}" ]] || die "Dozzle reported an empty host for '$q'; pass host~id explicitly"
  printf '%s\n' "$matches"
}

# --- time window --------------------------------------------------------------

iso_now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }

iso_since() {
  local v="$1"
  case "$v" in
    *m) date -u -d "-${v%m} min" +%Y-%m-%dT%H:%M:%S.%3NZ ;;
    *h) date -u -d "-${v%h} hour" +%Y-%m-%dT%H:%M:%S.%3NZ ;;
    *d) date -u -d "-${v%d} day" +%Y-%m-%dT%H:%M:%S.%3NZ ;;
    *) printf '%s' "$v" ;;
  esac
}

# --- shared log options -------------------------------------------------------

opt_all=0 opt_json=0 opt_since=15m opt_from= opt_to= opt_grep= opt_inverse=0 opt_tail=
opt_levels=()
log_query_args=()

parse_log_opts() {
  while (( $# )); do
    case "$1" in
      --all) opt_all=1 ;;
      --json) opt_json=1 ;;
      --since) opt_since="${2:?--since needs a value}"; shift ;;
      --from) opt_from="${2:?--from needs a value}"; shift ;;
      --to) opt_to="${2:?--to needs a value}"; shift ;;
      --grep) opt_grep="${2:?--grep needs a value}"; shift ;;
      --inverse) opt_inverse=1 ;;
      --level) opt_levels+=("${2:?--level needs a value}"); shift ;;
      --tail) opt_tail="${2:?--tail needs a value}"; shift ;;
      *) die "unknown option '$1'" ;;
    esac
    shift
  done
  if (( ! opt_all )); then
    [[ -n "$opt_from" ]] || opt_from=$(iso_since "$opt_since")
    [[ -n "$opt_to" ]] || opt_to=$(iso_now)
  fi
}

# The deployment at advangrid runs v11.0.1 against Kubernetes, where the
# server's from/to window (LogsBetweenDates) returns nothing — only `everything`
# does. So always ask for everything and slice by ts (epoch ms) on the client.
# --grep/--level/--inverse are still applied server-side inside that branch.
build_log_query() {
  log_query_args=(--data-urlencode "stdout=" --data-urlencode "stderr=" --data-urlencode "everything=")
  [[ -n "$opt_grep" ]] && log_query_args+=(--data-urlencode "filter=$opt_grep")
  (( opt_inverse )) && log_query_args+=(--data-urlencode "inverse=true")
  local l
  for l in ${opt_levels[@]+"${opt_levels[@]}"}; do
    log_query_args+=(--data-urlencode "levels=$l")
  done
  return 0
}

# --- commands -----------------------------------------------------------------

cmd_containers() {
  local all=0 json_out=0 json a
  for a in "$@"; do
    case "$a" in
      --all) all=1 ;;
      --json) json_out=1 ;;
      *) die "unknown option '$a'" ;;
    esac
  done
  json=$(snapshot)
  if (( json_out )) || ! have_jq; then
    if have_jq; then jq '.' <<<"$json"; else printf '%s\n' "$json"; fi
    return 0
  fi
  local filter='.'
  (( all )) || filter='select(.state == "running")'
  jq -r ".[] | $filter | [(.host // \"-\"), .state, (.health // \"-\"), .name, .image] | @tsv" <<<"$json" \
    | (printf 'HOST\tSTATE\tHEALTH\tNAME\tIMAGE\n'; cat) | column -t -s $'\t'
}

cmd_logs() {
  (( $# )) || die "usage: ag-dozzle logs <container> [options]"
  local target="$1"
  shift
  parse_log_opts "$@"
  ensure_login
  have_jq || die "jq is required"
  local host id name out code meta
  meta=$(resolve "$target") || exit 1
  IFS=$'\t' read -r host id name <<<"$meta"
  build_log_query
  # -w appends the status after a final newline so a Cloudflare error body cannot
  # masquerade as log output. The server always returns x-jsonl here because the
  # window is sliced locally by ts.
  out=$(curl -sS -m "$LOG_TIMEOUT" -b "$COOKIE_JAR" -G \
    "${log_query_args[@]}" \
    -H 'Accept: application/x-jsonl' \
    -w $'\n%{http_code}' \
    "$BASE/api/hosts/$host/containers/$id/logs")
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  [[ "$code" == 200 ]] || die "log fetch failed (HTTP $code) for $host/$id"
  if (( ! opt_all )); then
    local from_ms to_ms
    from_ms=$(date -d "$opt_from" +%s%3N)
    to_ms=$(date -d "$opt_to" +%s%3N)
    out=$(printf '%s\n' "$out" | jq -c --argjson f "$from_ms" --argjson t "$to_ms" 'select(.ts >= $f and .ts <= $t)')
  fi
  [[ -n "$out" ]] || { printf 'ag-dozzle: no log lines matched in the requested window\n' >&2; return 0; }
  if (( opt_json )); then
    out=$(printf '%s\n' "$out")
  else
    out=$(printf '%s\n' "$out" | jq -r '"\(.ts / 1000 | floor | todate) \(.l) \(if (.m | type) == "string" then .m else (.m | tostring) end)"')
  fi
  if [[ -n "$opt_tail" ]]; then
    printf '%s\n' "$out" | tail -n "$opt_tail"
  else
    printf '%s\n' "$out"
  fi
}

cmd_follow() {
  (( $# )) || die "usage: ag-dozzle follow <container> [--grep RE] [--inverse]"
  local target="$1"
  shift
  local grep_re="" inverse=0
  while (( $# )); do
    case "$1" in
      --grep) grep_re="${2:?--grep needs a value}"; shift ;;
      --inverse) inverse=1 ;;
      *) die "unknown option '$1'" ;;
    esac
    shift
  done
  ensure_login
  local host id meta
  meta=$(resolve "$target") || exit 1
  IFS=$'\t' read -r host id _ <<<"$meta"
  local -a args=(-sSN -m "${AG_FOLLOW_SECONDS:-60}" -b "$COOKIE_JAR"
    --data-urlencode "stdout=" --data-urlencode "stderr=")
  [[ -n "$grep_re" ]] && args+=(--data-urlencode "filter=$grep_re")
  (( inverse )) && args+=(--data-urlencode "inverse=true")
  printf 'ag-dozzle: following %s for %ss (raw SSE frames; Ctrl-C to stop)\n' "$target" "${AG_FOLLOW_SECONDS:-60}" >&2
  curl "${args[@]}" -G "$BASE/api/hosts/$host/containers/$id/logs/stream"
}

cmd_download() {
  (( $# )) || die "usage: ag-dozzle download <container>... [options]"
  local -a targets=()
  while (( $# )) && [[ "$1" != --* ]]; do
    targets+=("$1")
    shift
  done
  parse_log_opts "$@"
  ensure_login
  local -a ids=()
  local t host id joined out meta
  for t in "${targets[@]}"; do
    meta=$(resolve "$t") || exit 1
    IFS=$'\t' read -r host id _ <<<"$meta"
    ids+=("$host~$id")
  done
  joined=$(IFS=,; printf '%s' "${ids[*]}")
  out="${AG_DOWNLOAD_OUT:-dozzle-logs-$(date -u +%Y%m%dT%H%M%SZ).zip}"
  build_log_query
  curl -sS -m "$LOG_TIMEOUT" -b "$COOKIE_JAR" -G \
    "${log_query_args[@]}" \
    --data-urlencode "name=advangrid" \
    -o "$out" \
    "$BASE/api/containers/$joined/download"
  printf 'wrote %s\n' "$out"
}

cmd_api() {
  (( $# )) || die "usage: ag-dozzle api <GET-path>"
  ensure_login
  curl -sS -m "$LOG_TIMEOUT" -b "$COOKIE_JAR" "$BASE$1"
}

cmd_logout() {
  curl -sS -o /dev/null -m "$TIMEOUT" -b "$COOKIE_JAR" -X DELETE "$BASE/api/token" 2>/dev/null || true
  rm -f "$COOKIE_JAR"
  printf 'logged out\n'
}

usage() {
  sed -n '/^# Usage:/,/^# Environment:/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  containers) cmd_containers "$@" ;;
  find) (( $# )) || die "usage: ag-dozzle find <substring>"; resolve "$1" | column -t -s $'\t' ;;
  logs) cmd_logs "$@" ;;
  follow) cmd_follow "$@" ;;
  download) cmd_download "$@" ;;
  api) cmd_api "$@" ;;
  logout) cmd_logout ;;
  help | -h | --help) usage ;;
  *) die "unknown command '$cmd' (try: help)" ;;
esac
