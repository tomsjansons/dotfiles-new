# shell secrets via pass-cli, cached in the kernel persistent keyring.
#
#   API keys : exported in every interactive shell (sec-api-init). Values are
#              cached in the per-uid PERSISTENT keyring (_persistent.<uid>),
#              so steady-state shell startup is ~50ms and zero pass-cli calls.
#   SSH keys : loaded into a shared per-user ssh-agent (sec-ssh-init) whenever
#              the agent holds no keys (expiry via `ssh-add -t`). ONE
#              `pass-cli run` loads all keys; values never touch this shell's
#              env or disk.
#   Reboot   : keyring gone + pass-cli logged out -> inits fail silently in
#              <100ms (no network), shells start keyless. Run `sec-login`
#              once; every new shell then picks everything up automatically.
#
#   Why the persistent keyring (and not @u): keys written into @u are
#   readable only by processes that possess them, and possession requires a
#   valid session keyring. Shells descending from a process that outlived its
#   login (herdr, tmux servers, agent daemons) carry a session keyring
#   revoked by pam_keyinit -- from those shells @u is unreadable and every
#   shell would pay a full pass-cli fetch. The persistent keyring is per-uid,
#   survives logout, and `keyctl get_persistent` links it into any FRESH
#   session keyring -- so every cache access below runs inside a
#   `keyctl session -` wrapper and works identically from healthy and revoked
#   shells. This is the same mechanism pass-cli uses for its own DB key.
#   The wrapper dies with the command; durable state lives only in
#   _persistent.<uid> (cleared on reboot / after the kernel's inactivity
#   timeout, which every get_persistent re-arms).
#
#   Transport hook: every pass-cli invocation in this file goes through
#   sec-pass-cli(). The default wraps the call in a fresh anonymous session
#   keyring: from a shell with a revoked session keyring (long-lived parents:
#   herdr, tmux servers, agent daemons -- on ANY machine, laptops included)
#   pass-cli cannot link the persistent keyring into the caller's session and
#   every unwrapped call dies with NoStorageAccess(KeyRevoked). A fresh
#   session keyring fixes that universally and is harmless on healthy
#   shells. Boxes that want a specific named keyring override the function
#   BEFORE sourcing .zsh-secrets (the devinator zshrc pins `ppass`; see that
#   file).

# ---- configuration ----------------------------------------------------------
# Locate siblings relative to THIS file (symlinks resolved), so the trio can
# be deployed anywhere -- stow to ~, ZDOTDIR, a plain copy -- as long as the
# files stay siblings.
SEC_MAP_FILE="${${(%):-%N}:A:h}/.zsh-secrets.map"
SEC_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/shell-secrets"
SEC_FAIL_MARKER="$SEC_CACHE_DIR/failed"   # last failed fetch (throttles retries)
SEC_FETCH_STAMP="$SEC_CACHE_DIR/fetch"    # last successful fetch (cache age)
SEC_FAIL_TTL=60            # skip pass-cli attempts for N seconds after a failure
SEC_CACHE_TTL=$(( 12*3600 ))  # background-refresh the keyring cache after N seconds
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

# ---- transport hook -----------------------------------------------------------
# Fresh session keyring when keyctl exists (see header for why); plain exec
# otherwise. A machine-specific zshrc may define this function BEFORE
# sourcing .zsh-secrets to pin its own transport (devinator wraps pass-cli
# in the named `ppass` session keyring) -- this default only fills in when
# no override exists.
if (( ! $+functions[sec-pass-cli] )); then
  sec-pass-cli() {
    if (( $+commands[keyctl] )); then
      keyctl session - "$@"
    else
      "$@"
    fi
  }
fi

# ---- kernel keyring cache (persistent keyring, session-wrapped) ---------------
# Dump the cache: one wrapped child reads every known key and emits
# "NAME <base64>" lines. Works from healthy and revoked-session shells alike.
# Missing keys are simply absent from the output.
sec-cache-dump() {
  (( $+commands[keyctl] )) || return 1
  keyctl session - bash -c '
    pid=$(keyctl get_persistent @s "$EUID" 2>/dev/null) || exit 0
    for k in "$@"; do
      kid=$(keyctl search "$pid" user "sec:$k" 2>/dev/null) || continue
      b64=$(keyctl pipe "$kid" 2>/dev/null | base64 -w0) || continue
      [[ -n $b64 ]] && printf "%s %s\n" "$k" "$b64"
    done' sec-dump "$@" 2>/dev/null
}

# Store values into the cache: one wrapped child, values passed through the
# environment (never argv), names as arguments. Reads values from $SEC_FETCHED
# (the shell's exports may not exist yet at fetch time). Non-fatal if the
# kernel keyring is unavailable -- the fetch still exports into this shell.
sec-cache-store() {
  (( $+commands[keyctl] )) || return 0
  local -a envs names
  local k v
  for k in "$@"; do
    v=${SEC_FETCHED[$k]-}
    [[ -n $v ]] || continue
    envs+=("$k=$v")
    names+=("$k")
  done
  (( ${#names} )) || return 0
  keyctl session - env "${envs[@]}" bash -c '
    pid=$(keyctl get_persistent @s "$EUID" 2>/dev/null) || exit 0
    for k in "$@"; do
      printf %s "${!k}" | keyctl padd user "sec:$k" "$pid" >/dev/null 2>&1
    done' sec-store "${names[@]}" >/dev/null 2>&1
  return 0
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
# in (fails in <100ms, no network) or unreachable. Also refreshes the
# persistent-keyring cache, so the next shells are fast again.
sec-api-fetch() {
  (( $+commands[pass-cli] )) || return 1

  local out
  if (( $+commands[timeout] )); then
    out=$(sec-pass-cli timeout "$SEC_FETCH_TIMEOUT" pass-cli inject --in-file "$SEC_MAP_FILE" 2>/dev/null)
  else
    out=$(sec-pass-cli pass-cli inject --in-file "$SEC_MAP_FILE" 2>/dev/null)
  fi
  if (( $? != 0 )); then
    mkdir -p "$SEC_CACHE_DIR"
    print -r -- "${EPOCHSECONDS:-$(date +%s)}" >| "$SEC_FAIL_MARKER"
    return 1
  fi

  sec-api-parse <<< "$out"
  sec-cache-store "${(k)SEC_FETCHED[@]}"

  mkdir -p "$SEC_CACHE_DIR"
  print -r -- "${EPOCHSECONDS:-$(date +%s)}" >| "$SEC_FETCH_STAMP"
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

# ---- recent-fetch-failure throttle -------------------------------------------
sec-api-throttled() {
  [[ -r $SEC_FAIL_MARKER ]] || return 1
  local last=0 now=${EPOCHSECONDS:-$(date +%s)}
  [[ -s $SEC_FAIL_MARKER ]] && last=$(<"$SEC_FAIL_MARKER")
  (( now - last < SEC_FAIL_TTL ))
}

# ---- startup init: silent, fast ----------------------------------------------
# Fast path: one wrapped keyring dump (~15ms) + export. Cold path (cache
# empty): foreground pass-cli fetch in this one shell. Stale-but-complete
# cache: instant export, then a throttled background refresh -- this shell
# keeps the old values, every later shell sees the fresh ones.
sec-api-init() {
  (( $+commands[pass-cli] )) || return 0

  local out k v
  local -a missing=()

  if out=$(sec-cache-dump "${(@)SEC_API_KEYS}") && [[ -n $out ]]; then
    local b64
    while read -r k b64; do
      [[ -n $k && -n $b64 ]] || continue
      if v=$(command base64 -d -- <<< "$b64" 2>/dev/null) && [[ -n $v ]]; then
        export "$k=$v"
      else
        missing+=("$k")
      fi
    done <<< "$out"
    (( ${#missing} )) || sec-api-derive
  else
    missing=("${(@)SEC_API_KEYS}")
  fi

  # keys still missing -> foreground fetch (first shell after reboot)
  if (( ${#missing} )); then
    sec-api-throttled && return 1
    sec-api-fetch || return 1
    for k in ${(k)SEC_FETCHED}; do
      v=${SEC_FETCHED[$k]}
      [[ -n $v ]] && export "$k=$v"
    done
    sec-api-derive
    return 0
  fi

  # complete but stale -> refresh in the background (throttled by the stamp;
  # the optimistic stamp write keeps a burst of shells to one fetch)
  local now=${EPOCHSECONDS:-$(date +%s)} last=0
  [[ -r $SEC_FETCH_STAMP ]] && last=$(<"$SEC_FETCH_STAMP")
  (( now - last < SEC_CACHE_TTL )) && return 0
  sec-api-throttled && return 0
  mkdir -p "$SEC_CACHE_DIR"
  print -r -- "$now" >| "$SEC_FETCH_STAMP"
  # disowned + fully detached from stdout/stderr: a non-tty parent (agent
  # harness, CI) would otherwise wait on the pipe this job inherits
  { sec-api-fetch >/dev/null 2>&1 } &!
  return 0
}

# ---- ssh-agent: reuse any live agent, else a per-user persistent one ---------
sec-ssh-agent() {
  local st
  if [[ -n "$SSH_AUTH_SOCK" ]]; then
    ssh-add -l >/dev/null 2>&1
    st=$?
    (( st < 2 )) && return 0
  fi
  # no live agent on $SSH_AUTH_SOCK: point at a per-user socket and make sure
  # an agent is listening on it
  local dir="${XDG_RUNTIME_DIR:-/tmp}"
  [[ -d $dir ]] || dir="/tmp"
  local sock="$dir/ssh-agent-$UID.sock"
  export SSH_AUTH_SOCK="$sock"
  ssh-add -l >/dev/null 2>&1
  (( $? < 2 )) && return 0
  command rm -f "$sock" 2>/dev/null
  eval "$(ssh-agent -a "$sock" -s)" >/dev/null
}

# ---- ssh key refs in the vault (env var -> pass:// mapping for pass-cli run) -
sec-ssh-env-map() {
  cat <<'EOF'
SEC_L13_KEY=pass://Personal/lenovo l13 private key/note
SEC_ADV_KEY=pass://Personal/advangrid-ssh/note
SEC_PANDORA_KEY=pass://Personal/advangrid pandora-admin/private
EOF
}

# ---- ssh loader: ONE pass-cli run pipes every key into ssh-add ---------------
# Silent worker; prints per-key result lines. Returns 1 if nothing loaded.
sec-ssh-load() {
  (( $+commands[pass-cli] && $+commands[ssh-add] )) || return 1
  sec-ssh-agent || return 1
  local out
  out=$(SEC_SSH_TTL="$SEC_SSH_KEY_TTL" sec-pass-cli pass-cli run \
        --env-file <(sec-ssh-env-map) -- bash -c '
          for k in $(compgen -e | grep "^SEC_" | grep -v "^SEC_SSH_TTL$"); do
            val=${!k:-}
            if [[ -n $val ]] && printf "%s\n" "$val" | ssh-add -t "$SEC_SSH_TTL" - >/dev/null 2>&1; then
              echo "loaded: $k"
            else
              echo "failed: $k"
            fi
          done' 2>/dev/null) || return 1
  [[ -n "$out" ]] && print -r -- "$out"
  [[ "$out" == *'loaded:'* ]]
}

# ---- startup init for ssh: silent, ~5ms when the agent still holds keys ------
# Agent first (reuses the shared per-user agent across shells), then the
# key check -- with no inherited SSH_AUTH_SOCK the raw probe would always
# miss and every shell would pay a full pass-cli run.
sec-ssh-init() {
  (( $+commands[pass-cli] && $+commands[ssh-add] )) || return 0
  sec-ssh-agent || return 0
  ssh-add -l >/dev/null 2>&1 && return 0   # agent holds keys (any TTL left)
  sec-ssh-load >/dev/null 2>&1
}

# ---- user helpers --------------------------------------------------------------
# sec-api  : force-refresh the API keys in THIS shell (fetch + export)
# sec-ssh  : force-(re)load the ssh keys into THIS session's agent
# sec-login: pass-cli login, then both of the above
# sec-status: what is where right now

sec-api() {
  command rm -f "$SEC_FAIL_MARKER"
  sec-api-fetch || { print -u2 "sec: fetch failed (not logged in? run: sec-login)"; return 1 }
  local k v n=0
  for k in ${(k)SEC_FETCHED}; do
    v=${SEC_FETCHED[$k]}
    if [[ -n $v ]]; then export "$k=$v"; (( n++ )); fi
  done
  sec-api-derive
  print "sec: api ok -- $n keys exported"
}

sec-ssh() {
  local out
  out=$(sec-ssh-load) || { print -u2 "sec: ssh load failed (not logged in? run: sec-login)"; return 1 }
  print -r -- "$out"
  print "sec: ssh agent holds $(ssh-add -l 2>/dev/null | wc -l) key(s)"
}

sec-login() {
  if ! sec-pass-cli pass-cli info >/dev/null 2>&1; then
    print "sec: pass-cli session unavailable -- logging in"
    sec-pass-cli pass-cli login || { print -u2 "sec: login failed"; return 1 }
  fi
  sec-api || return 1
  sec-ssh
}

sec-status() {
  local k v state dump name b64
  print "shell secrets (kernel persistent keyring):"
  dump=$(sec-cache-dump "${(@)SEC_API_KEYS}" 2>/dev/null)
  local -A cached=()
  while read -r name b64; do
    [[ -n $name && -n $b64 ]] && cached[$name]=1
  done <<< "${dump}"
  for k in $SEC_API_KEYS; do
    if [[ -n ${(P)k-} ]]; then
      state="exported"
      [[ -n ${cached[$k]-} ]] && state+=" (cached)"
    elif [[ -n ${cached[$k]-} ]]; then
      state="cached only"
    else
      state="MISSING"
    fi
    printf '  %-34s %s\n' "$k" "$state"
  done
  local now=${EPOCHSECONDS:-$(date +%s)} last=0
  [[ -r $SEC_FETCH_STAMP ]] && last=$(<"$SEC_FETCH_STAMP")
  (( last > 0 )) && print "cache fetched: $(( (now - last) / 60 )) min ago"
  print "ssh agent ($SSH_AUTH_SOCK): $(ssh-add -l 2>/dev/null | wc -l) key(s)"
}
