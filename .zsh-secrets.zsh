# shell secrets via pass-cli, cached in the kernel keyring (@u).
#
#   API keys : exported in every interactive shell. Values are cached in the
#              kernel keyring (cleared on logout/reboot), so steady-state shell
#              startup costs ~50ms and zero pass-cli calls.
#   Reboot   : keyring empty + pass-cli logged out -> fetch fails in <100ms
#              (no network), shells start keyless. Run `sec-login` once;
#              every new shell then picks keys up automatically.
#   SSH keys : per-session opt-in via `sec-ssh-init` (called from z()).
#              ONE `pass-cli run` process loads all keys into THIS session's
#              ssh-agent. Keys never touch the parent shell env or disk.

# ---- configuration ----------------------------------------------------------
# Locate the map relative to THIS file (symlinks resolved), so the pair can be
# deployed anywhere -- stow to ~, ZDOTDIR, a plain copy -- as long as the two
# files stay siblings.
SEC_MAP_FILE="${${(%):-%N}:A:h}/.zsh-secrets.map"
SEC_FAIL_MARKER="${XDG_CACHE_HOME:-$HOME/.cache}/shell-secrets/failed"
SEC_FAIL_TTL=60            # skip pass-cli attempts for N seconds after a failure
SEC_SSH_KEY_TTL=8h         # ssh-add lifetime for pass-sourced keys
SEC_FETCH_TIMEOUT=20       # cap on a single pass-cli fetch (network black-hole guard)

typeset -aU SEC_API_KEYS
SEC_API_KEYS=(
  OPENCODE_ZEN_API_KEY
  TAVILY_API_KEY
  OPENROUTER_API_KEY
  MINIMAX_API_KEY
  ZAI_API_KEY
  QWENCLOUD_TOKEN_PLAN_API_KEY
  HERMES_SUDO_PWD
  PREVIEW_SUDO_PWD
  ADV_PROD_MYSQL_URI
)

typeset -A SEC_FETCHED     # name -> value from the last successful fetch

# ---- kernel keyring helpers --------------------------------------------------
sec-kr-get() {
  local kid
  kid=$(keyctl search @u user "sec:$1" 2>/dev/null) || return 1
  keyctl pipe "$kid" 2>/dev/null
}

sec-kr-set() {
  printf %s "$2" | keyctl padd user "sec:$1" @u >/dev/null 2>&1
}

# ---- parse `pass-cli inject` output ------------------------------------------
# Input on stdin:  <<<NAME \n value lines...  blocks (value may span lines).
# Values are treated as data only -- never eval'd. Fills $SEC_FETCHED.
sec-api-parse() {
  SEC_FETCHED=()
  local line name="" buf=""
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == '<<<'* ]]; then
      [[ -n $name ]] && SEC_FETCHED[$name]=${buf%$'\n'}
      name=${line#'<<<'}
      buf=""
    elif [[ -n $name ]]; then
      buf+=$line$'\n'
    fi
  done
  [[ -n $name ]] && SEC_FETCHED[$name]=${buf%$'\n'}
}

# ---- one batched pass-cli fetch: vault listed once, all refs resolved --------
# Returns 1 (and writes the fail-marker) if pass-cli fails -- e.g. not logged
# in (fails in <100ms, no network) or unreachable.
sec-api-fetch() {
  (( $+commands[keyctl] )) || return 1

  local out
  if (( $+commands[timeout] )); then
    out=$(timeout "$SEC_FETCH_TIMEOUT" pass-cli inject --in-file "$SEC_MAP_FILE" 2>/dev/null)
  else
    out=$(pass-cli inject --in-file "$SEC_MAP_FILE" 2>/dev/null)
  fi
  if (( $? != 0 )); then
    mkdir -p "${SEC_FAIL_MARKER:h}"
    print -r -- "${EPOCHSECONDS:-$(date +%s)}" >| "$SEC_FAIL_MARKER"
    return 1
  fi

  sec-api-parse <<< "$out"

  local k v
  for k in ${(k)SEC_FETCHED}; do
    v=${SEC_FETCHED[$k]}
    [[ -n $v ]] && sec-kr-set "$k" "$v"
  done
  return 0
}

# ---- derived exports (after ADV_PROD_MYSQL_URI is available) -----------------
sec-api-derive() {
  local uri=${ADV_PROD_MYSQL_URI-}
  [[ -n $uri ]] || return 1
  local pattern='^mysql://([^:]+):([^@]+)@([^:]+):([0-9]+)/([^?]+)(\?.*)?$'
  if [[ $uri =~ $pattern ]]; then
    export ADV_PROD_MYSQL_USER="${match[1]}"
    export ADV_PROD_MYSQL_PWD="${match[2]}"
    export ADV_PROD_MYSQL_HOST="${match[3]}"
    export ADV_PROD_MYSQL_PORT="${match[4]}"
  else
    print -u2 "sec: failed to parse ADV_PROD_MYSQL_URI"
    return 1
  fi
}

# ---- called at shell startup: silent, fast -----------------------------------
sec-api-init() {
  local k v
  local -a pending=()
  for k in $SEC_API_KEYS; do
    if v=$(sec-kr-get "$k") && [[ -n $v ]]; then
      export "$k=$v"
    else
      pending+=("$k")
    fi
  done
  (( ${#pending} )) || { sec-api-derive; return 0 }

  # short-circuit after a recent failure (burst of shells / offline machine)
  if [[ -r $SEC_FAIL_MARKER ]]; then
    local last=0 now=${EPOCHSECONDS:-$(date +%s)}
    [[ -s $SEC_FAIL_MARKER ]] && last=$(<"$SEC_FAIL_MARKER")
    (( now - last < SEC_FAIL_TTL )) && return 1
  fi

  sec-api-fetch || return 1

  for k in $pending; do
    v=${SEC_FETCHED[$k]-}
    [[ -n $v ]] && export "$k=$v"
  done
  sec-api-derive
}

# ---- user-facing helpers ------------------------------------------------------
sec-refresh() {
  command rm -f "$SEC_FAIL_MARKER"
  if sec-api-fetch; then
    local k v n=0
    for k in ${(k)SEC_FETCHED}; do
      v=${SEC_FETCHED[$k]}
      if [[ -n $v ]]; then export "$k=$v"; (( n++ )); fi
    done
    sec-api-derive
    print "sec: refreshed $n secrets"
  else
    print -u2 "sec: fetch failed (not logged in? run: sec-login)"
    return 1
  fi
}

sec-login() {
  pass-cli login || return 1
  sec-refresh
}

sec-status() {
  local k v state
  print "shell secrets (kernel keyring @u):"
  for k in $SEC_API_KEYS; do
    v=$(sec-kr-get "$k" 2>/dev/null)
    if [[ -n ${(P)k-} ]]; then
      state="exported"
      [[ -n $v ]] && state+=" (keyring)"
    elif [[ -n $v ]]; then
      state="keyring only"
    else
      state="MISSING"
    fi
    printf '  %-34s %s\n' "$k" "$state"
  done
  print "ssh keys in agent: $(ssh-add -l 2>/dev/null | wc -l)"
}

# ---- ssh keys: batched load into THIS session's agent (opt-in) ----------------
sec-ssh-agent() {
  ssh-add -l >/dev/null 2>&1
  local agent_status=$?
  (( agent_status == 2 )) && eval "$(ssh-agent -s)"
}

sec-ssh-env-map() {
  cat <<'EOF'
SEC_L13_KEY=pass://Personal/lenovo l13 private key/note
SEC_ADV_KEY=pass://Personal/advangrid-ssh/note
SEC_PANDORA_KEY=pass://Personal/advangrid pandora-admin/private
EOF
}

sec-ssh-init() {
  sec-ssh-agent

  local out rc
  out=$(SEC_SSH_TTL="$SEC_SSH_KEY_TTL" pass-cli run --env-file <(sec-ssh-env-map) -- bash -c '
    for k in SEC_L13_KEY SEC_ADV_KEY SEC_PANDORA_KEY; do
      val=${!k:-}
      if [[ -n $val ]] && printf "%s\n" "$val" | ssh-add -t "$SEC_SSH_TTL" - 2>/dev/null; then
        echo "loaded: $k"
      else
        echo "failed: $k"
      fi
    done')
  rc=$?

  if (( rc != 0 )); then
    print -u2 "sec: ssh key load failed (pass-cli not logged in? run: sec-login)"
    return 1
  fi
  print -- "$out"
  print "sec: ssh agent holds $(ssh-add -l 2>/dev/null | wc -l) key(s)"
}
