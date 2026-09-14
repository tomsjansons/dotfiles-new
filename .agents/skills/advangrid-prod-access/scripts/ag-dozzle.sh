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
#   logs     GET /api/hosts/{host}/containers/{id}/logs?from=&to=&stdout&stderr
#            returns application/x-jsonl, or text/plain when the request sends
#            `Accept: text/plain`. Add `everything` to ignore from/to.
#   follow   GET /api/hosts/{host}/containers/{id}/logs/stream (SSE).
#   download GET /api/containers/{host~id,...}/download?... returns a ZIP of
#            log files (needs the `download` role).
#
# Credentials come from the environment, populated by pass-cli (see
# ~/.zsh-secrets.map). The `jwt` cookie is cached in the runtime dir so repeat
# calls skip the login round-trip. Nothing secret is ever written to argv.
#
# Usage:
#   ag-dozzle containers [--all]
#   ag-dozzle find <name-substring>
#   ag-dozzle logs <name-substring|host~id> [options]
#   ag-dozzle follow <name-substring|host~id> [--grep RE] [--inverse]
#   ag-dozzle download <name-substring|host~id>... [options]
#   ag-dozzle api <GET-path>            authenticated GET, body to stdout
#   ag-dozzle logout
#
# logs/download options:
#   --since 30m            window ending now (default 15m; m/h/d suffixes)
#   --from ISO --to ISO    explicit RFC3339 window
#   --all                  everything the server retains (ignores the window)
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

# percent-encode stdin/arg without external tools (host names and container ids
# are ASCII, which is all this needs to handle)
urlenc() {
  local s="$1" out="" c i
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) printf -v c '%%%02X' "'$c"; out+="$c" ;;
    esac
  done
  printf '%s' "$out"
}

need_creds() {
  [[ -n "${ADV_PROD_DOZZLE_USER:-}" && -n "${ADV_PROD_DOZZLE_PWD:-}" ]] || die \
    "ADV_PROD_DOZZLE_USER / ADV_PROD_DOZZLE_PWD are unset. Run 'sec-login' (or 'sec-api') in zsh first."
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
  [[ "$code" == 200 ]] || die "login failed (HTTP $code) — check $BASE and the ADV_PROD_DOZZLE_* credentials"
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
    printf '%s\n' "$matches" | awk -F'\t' '{printf "  %s  %s  %s\n", $1, substr($2, 1, 12), $3}' >&2
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

build_log_query() {
  log_query_args=(--data-urlencode "stdout=" --data-urlencode "stderr=")
  (( opt_all )) && log_query_args+=(--data-urlencode "everything=")
  [[ -n "$opt_from" ]] && log_query_args+=(--data-urlencode "from=$opt_from")
  [[ -n "$opt_to" ]] && log_query_args+=(--data-urlencode "to=$opt_to")
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
  local all=0 json
  [[ "${1:-}" == "--all" ]] && all=1
  json=$(snapshot)
  if ! have_jq; then
    printf '%s\n' "$json"
    return 0
  fi
  local filter='.'
  (( all )) || filter='select(.state == "running")'
  jq -r ".[] | $filter | [(.host // \"-\"), (.id[0:12]), .state, (.health // \"-\"), .name, .image] | @tsv" <<<"$json" \
    | column -t -s $'\t'
}

cmd_logs() {
  (( $# )) || die "usage: ag-dozzle logs <container> [options]"
  local target="$1"
  shift
  parse_log_opts "$@"
  ensure_login
  local host id name accept out
  IFS=$'\t' read -r host id name <<<"$(resolve "$target")"
  accept="text/plain"
  (( opt_json )) && accept="application/x-jsonl"
  build_log_query
  out=$(curl -sS -m "$LOG_TIMEOUT" -b "$COOKIE_JAR" -G \
    "${log_query_args[@]}" \
    -H "Accept: $accept" \
    "$BASE/api/hosts/$(urlenc "$host")/containers/$(urlenc "$id")/logs")
  if [[ -n "$out" ]]; then
    if [[ -n "$opt_tail" ]]; then
      printf '%s\n' "$out" | tail -n "$opt_tail"
    else
      printf '%s\n' "$out"
    fi
  else
    printf 'ag-dozzle: no log lines matched in the requested window\n' >&2
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
  local host id
  IFS=$'\t' read -r host id _ <<<"$(resolve "$target")"
  local -a args=(-sSN -m "${AG_FOLLOW_SECONDS:-60}" -b "$COOKIE_JAR" -H 'Accept: text/plain')
  [[ -n "$grep_re" ]] && args+=(--data-urlencode "filter=$grep_re")
  (( inverse )) && args+=(--data-urlencode "inverse=true")
  printf 'ag-dozzle: following %s for %ss (Ctrl-C to stop)\n' "$target" "${AG_FOLLOW_SECONDS:-60}" >&2
  curl "${args[@]}" -G "$BASE/api/hosts/$(urlenc "$host")/containers/$(urlenc "$id")/logs/stream"
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
  local t host id joined out
  for t in "${targets[@]}"; do
    IFS=$'\t' read -r host id _ <<<"$(resolve "$t")"
    ids+=("$host~$id")
  done
  joined=$(IFS=,; printf '%s' "${ids[*]}")
  out="${AG_DOWNLOAD_OUT:-dozzle-logs-$(date -u +%Y%m%dT%H%M%SZ).zip}"
  build_log_query
  curl -sS -m "$LOG_TIMEOUT" -b "$COOKIE_JAR" -G \
    "${log_query_args[@]}" \
    --data-urlencode "name=advangrid" \
    -o "$out" \
    "$BASE/api/containers/$(urlenc "$joined")/download"
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
