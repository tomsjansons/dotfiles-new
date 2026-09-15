#!/usr/bin/env bash
# ag-inngest — query the Advangrid production Inngest server over HTTP.
#
# READ-ONLY. This script only issues `query` operations (plus plain GETs);
# mutations, event ingestion and function invocation are deliberately absent.
#
# The deployment sits behind Traefik HTTP Basic auth (realm "traefik"), so every
# request needs credentials. Behind that it is the Inngest OSS server. The one
# surface this script uses:
#
#   /v0/gql      GraphQL — what the web UI itself uses, and the only surface
#                Inngest does not put its own auth middleware in front of.
#                (/e/<key> and /invoke/<slug> would write; /v1 and /v2 want a
#                Bearer signing key that collides with the Traefik Basic
#                credentials in the single Authorization header.)
#
# Credentials come from the environment, populated by pass-cli (see
# ~/.zsh-secrets.map). They are handed to curl through a 0600 config file, never
# argv. GraphQL queries are copied from the Inngest UI's own documents
# (ui/apps/dev-server-ui/src/store/generated.ts).
#
# Usage:
#   ag-inngest apps [--json]              apps and their functions
#   ag-inngest functions [--json]
#   ag-inngest runs [options]             recent runs (table)
#   ag-inngest run <runID> [--json]       one run
#   ag-inngest gql <query|file> [vars-json]
#   ag-inngest api <GET-path>             authenticated raw GET
#
# runs options:
#   --since 1h             window ending now (default 1h; m/h/d suffixes)
#   --from ISO --until ISO explicit RFC3339 window
#   --status failed,queued comma list of QUEUED RUNNING COMPLETED FAILED CANCELLED SKIPPED
#   --app NAME             restrict to an app (name or externalID)
#   --fn SLUG              restrict to a function slug
#   --cel EXPR             CEL filter, e.g. 'event.name == "app/x"'
#   --limit N              page size (default 20)
#   --json                 raw JSON instead of a table
#
# Environment:
#   ADV_PROD_INNGEST_URL   base URL (default https://inngest.advangrid.com)
#   ADV_PROD_INNGEST_USER  Traefik basic auth user (from pass-cli)
#   ADV_PROD_INNGEST_PWD   Traefik basic auth password (from pass-cli)
#   AG_HTTP_TIMEOUT        per-request seconds (default 60)
set -euo pipefail

BASE="${ADV_PROD_INNGEST_URL:-https://inngest.advangrid.com}"
BASE="${BASE%/}"
TIMEOUT="${AG_HTTP_TIMEOUT:-60}"

die() { printf 'ag-inngest: %s\n' "$*" >&2; exit 1; }
need_jq() { command -v jq >/dev/null 2>&1 || die "jq is required"; }

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
  load_var ADV_PROD_INNGEST_USER && load_var ADV_PROD_INNGEST_PWD || die \
    "ADV_PROD_INNGEST_USER / ADV_PROD_INNGEST_PWD unavailable. Run 'sec-login' (or 'sec-api') in zsh first."
}

# curl with Basic auth from a 0600 config file, so the password never shows up
# in the process list. 2xx prints the body; anything else fails with the body
# on stderr.
_curl() {
  need_creds
  local cfg tmp code u p
  cfg=$(mktemp)
  tmp=$(mktemp)
  chmod 600 "$cfg" "$tmp"
  u=${ADV_PROD_INNGEST_USER//\\/\\\\}
  u=${u//\"/\\\"}
  p=${ADV_PROD_INNGEST_PWD//\\/\\\\}
  p=${p//\"/\\\"}
  printf 'user = "%s:%s"\n' "$u" "$p" >"$cfg"
  code=$(curl -sS -m "$TIMEOUT" -K "$cfg" -o "$tmp" -w '%{http_code}' "$@") || code=000
  rm -f "$cfg"
  if [[ "$code" =~ ^2 ]]; then
    cat "$tmp"
    rm -f "$tmp"
    return 0
  fi
  printf 'ag-inngest: HTTP %s from %s\n' "$code" "$BASE" >&2
  cat "$tmp" >&2
  printf '\n' >&2
  rm -f "$tmp"
  return 1
}

# --- canonical GraphQL documents ---------------------------------------------

QRY_FUNCTIONS='query GetFunctions { functions { id slug name url triggers { type value } app { name method } } }'

QRY_APPS='query GetApps { apps { id name appVersion sdkLanguage sdkVersion framework url error connected functionCount method functions { id slug name } } }'

QRY_RUNS='query GetRuns($startTime: Time!, $until: Time, $status: [FunctionRunStatus!], $timeField: RunsV2OrderByField!, $appIDs: [UUID!], $functionIDs: [UUID!], $celQuery: String, $first: Int = 20) {
  runs(first: $first, filter: {from: $startTime, until: $until, status: $status, timeField: $timeField, appIDs: $appIDs, functionIDs: $functionIDs, query: $celQuery}, orderBy: [{field: $timeField, direction: DESC}]) {
    totalCount
    edges { node { id status queuedAt startedAt endedAt eventName isBatch function { name slug } app { name externalID } } }
    pageInfo { hasNextPage endCursor }
  }
}'

QRY_RUN='query GetRun($runID: String!) {
  run(runID: $runID) {
    id
    status
    eventName
    queuedAt
    startedAt
    endedAt
    hasAI
    function { id name slug app { name } }
    trace { name status durationMS childrenSpans { name status durationMS childrenSpans { name status durationMS childrenSpans { name status durationMS } } } }
  }
}'

# --- GraphQL helpers ----------------------------------------------------------

# Refuse anything that writes. Comments and string literals are stripped first so
# a query that merely mentions the word (inside a CEL string, say) still passes.
_assert_read_only() {
  local stripped
  stripped=$(printf '%s' "$1" | sed -E 's/#[^\n]*//g; s/"(\\.|[^"\\])*"//g')
  if printf '%s' "$stripped" | grep -Eqi '(^|[^A-Za-z0-9_])(mutation|subscription)([^A-Za-z0-9_]|$)'; then
    die "read-only: mutation/subscription operations are not allowed"
  fi
}

# Print .data as pretty JSON, or the GraphQL errors and fail.
_gql_post() {
  local query="$1" vars_json="${2:-{\}}" body
  need_jq
  _assert_read_only "$query"
  body=$(jq -n --arg q "$query" --argjson v "$vars_json" '{query: $q, variables: $v}')
  _curl -X POST -H 'Content-Type: application/json' --data-binary "$body" "$BASE/v0/gql"
}

_gql() {
  local out
  out=$(_gql_post "$1" "${2:-{\}}") || exit 1
  if jq -e '.errors' >/dev/null 2>&1 <<<"$out"; then
    jq -r '.errors[].message' <<<"$out" >&2
    exit 1
  fi
  printf '%s' "$out"
}

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

# --- commands -----------------------------------------------------------------

cmd_apps() {
  local out
  out=$(_gql "$QRY_APPS")
  if [[ "${1:-}" == "--json" ]]; then
    jq '.data' <<<"$out"
    return 0
  fi
  jq -r '.data.apps[] | .name as $app | .functions[] | [$app, .slug, .name, .id] | @tsv' <<<"$out" \
    | (printf 'APP\tSLUG\tNAME\tFUNCTION-ID\n'; cat) | column -t -s $'\t'
}

cmd_functions() {
  local out
  out=$(_gql "$QRY_FUNCTIONS")
  if [[ "${1:-}" == "--json" ]]; then
    jq '.data' <<<"$out"
    return 0
  fi
  jq -r '.data.functions[] | [(.app.name // "-"), .slug, .name, .id] | @tsv' <<<"$out" \
    | (printf 'APP\tSLUG\tNAME\tFUNCTION-ID\n'; cat) | column -t -s $'\t'
}

# Resolve an app name/externalID or function slug to its UUID for the filter.
_resolve_app_id() {
  local want="$1"
  _gql "$QRY_APPS" | jq -r --arg w "$want" \
    '.data.apps[] | select(.name == $w or .id == $w) | .id' | head -n1
}

_resolve_function_id() {
  local want="$1"
  _gql "$QRY_FUNCTIONS" | jq -r --arg w "$want" \
    '.data.functions[] | select(.slug == $w or .id == $w) | .id' | head -n1
}

cmd_runs() {
  need_jq
  local since=1h from="" until="" status="" app="" fn="" cel="" limit=20 json=0
  while (( $# )); do
    case "$1" in
      --since) since="${2:?--since needs a value}"; shift ;;
      --from) from="${2:?--from needs a value}"; shift ;;
      --until) until="${2:?--until needs a value}"; shift ;;
      --status) status="${2:?--status needs a value}"; shift ;;
      --app) app="${2:?--app needs a value}"; shift ;;
      --fn) fn="${2:?--fn needs a value}"; shift ;;
      --cel) cel="${2:?--cel needs a value}"; shift ;;
      --limit) limit="${2:?--limit needs a value}"; shift ;;
      --json) json=1 ;;
      *) die "unknown option '$1'" ;;
    esac
    shift
  done
  [[ -n "$from" ]] || from=$(iso_since "$since")
  local vars='{}'
  vars=$(jq -n --arg from "$from" --arg status "$status" --arg cel "$cel" --argjson first "$limit" '{
    startTime: $from,
    first: $first,
    timeField: "QUEUED_AT",
    status: (if $status == "" then null else ($status | split(",") | map(ascii_upcase)) end),
    celQuery: (if $cel == "" then null else $cel end),
    appIDs: null,
    functionIDs: null
  }')
  [[ -n "$until" ]] && vars=$(jq --arg u "$until" '. + {until: $u}' <<<"$vars")
  if [[ -n "$app" ]]; then
    local aid
    aid=$(_resolve_app_id "$app")
    [[ -n "$aid" ]] || die "no app matches '$app'"
    vars=$(jq --arg id "$aid" '.appIDs = [$id]' <<<"$vars")
  fi
  if [[ -n "$fn" ]]; then
    local fid
    fid=$(_resolve_function_id "$fn")
    [[ -n "$fid" ]] || die "no function matches '$fn'"
    vars=$(jq --arg id "$fid" '.functionIDs = [$id]' <<<"$vars")
  fi
  local out
  out=$(_gql "$QRY_RUNS" "$vars")
  if (( json )); then
    jq '.data' <<<"$out"
    return 0
  fi
  printf 'total=%s  from=%s\n' "$(jq -r '.data.runs.totalCount' <<<"$out")" "$from"
  jq -r '.data.runs.edges[].node
    | [.queuedAt, .status, (.function.slug // "-"), (.eventName // "-"), (.app.name // "-"), .id] | @tsv' <<<"$out" \
    | (printf 'QUEUED-AT\tSTATUS\tFUNCTION\tEVENT\tAPP\tRUN-ID\n'; cat) | column -t -s $'\t'
}

cmd_run() {
  (( $# )) || die "usage: ag-inngest run <runID> [--json]"
  local id="$1" json=0
  [[ "${2:-}" == "--json" ]] && json=1
  local out
  out=$(_gql "$QRY_RUN" "$(jq -n --arg id "$id" '{runID: $id}')")
  if (( json )); then
    jq '.data' <<<"$out"
    return 0
  fi
  jq -r '.data.run | "run    \(.id)\nstatus \(.status)\nfn     \(.function.slug)\napp    \(.function.app.name)\nevent  \(.eventName // "-")\nqueued \(.queuedAt)\nstart  \(.startedAt // "-")\nend    \(.endedAt // "-")"' <<<"$out"
  jq -r '.data.run.trace | if . == null then "trace  (none)" else "trace  \(.name) \(.status) \(.durationMS // "-")ms" end' <<<"$out"
}

cmd_gql() {
  (( $# )) || die "usage: ag-inngest gql <query|file> [vars-json]"
  local q="$1" vars="${2:-{\}}"
  if [[ -f "$q" ]]; then
    q=$(cat "$q")
  fi
  _gql "$q" "$vars" | jq '.data'
}

cmd_api() {
  (( $# )) || die "usage: ag-inngest api <GET-path>"
  _curl -X GET "$BASE$1"
  printf '\n'
}

usage() {
  sed -n '/^# Usage:/,/^# Environment:/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  apps) cmd_apps "$@" ;;
  functions) cmd_functions "$@" ;;
  runs) cmd_runs "$@" ;;
  run) cmd_run "$@" ;;
  gql) cmd_gql "$@" ;;
  api) cmd_api "$@" ;;
  help | -h | --help) usage ;;
  *) die "unknown command '$cmd' (try: help)" ;;
esac
