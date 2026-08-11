
# Lines configured by zsh-newuser-install
HISTFILE=~/.histfile
HISTSIZE=1000
SAVEHIST=1000
unsetopt beep
bindkey -v
# End of lines configured by zsh-newuser-install
# The following lines were added by compinstall
zstyle :compinstall filename '/home/toms/.zshrc'

autoload -Uz compinit
compinit
# End of lines added by compinstall

zmodload zsh/datetime 2>/dev/null
cached-zsh-init() {
  local name="$1"
  local generator="$2"
  local max_age_seconds="${3:-86400}"
  local cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/zsh/generated"
  local cache_file="$cache_dir/$name.zsh"
  local stamp_file="$cache_file.stamp"

  mkdir -p "$cache_dir"

  [[ -r "$cache_file" ]] && source "$cache_file"

  local now=${EPOCHSECONDS:-$(date +%s)} last=0
  [[ -r "$stamp_file" ]] && last=$(<"$stamp_file")
  (( now - last < max_age_seconds )) && return

  {
    local tmp="$cache_file.tmp.$$"
    if eval "$generator" >| "$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
      mv "$tmp" "$cache_file"
      print -r -- "${EPOCHSECONDS:-$(date +%s)}" >| "$stamp_file"
    fi
    rm -f "$tmp"
  } &!
}
#

bindkey "^[[H" beginning-of-line
bindkey "^[[F" end-of-line
bindkey "^[[3~" delete-char
bindkey "^[[1;5D" backward-word
bindkey "^[[1;5C" forward-word


eval "$(oh-my-posh init zsh --config /home/toms/.config/oh-my-posh/amro.omp.json)"
cached-zsh-init luarocks 'command luarocks path --no-bin'
export PATH="$HOME/.luarocks/bin:$PATH"
eval "$(mise activate zsh)"

[[ -t 0 && -t 1 ]] && command -v fzf >/dev/null 2>&1 && cached-zsh-init fzf 'command fzf --zsh'

export EDITOR='nvim'
export VISUAL='ghostty -e nvim'

export GOPATH="${GOPATH:-$HOME/go}"
[[ -n "$GOBIN" ]] && export PATH="$PATH:$GOBIN"
export PATH="$PATH:$GOPATH/bin"
export PATH="$PATH:/home/toms/.lmstudio/bin"

command -v niri >/dev/null 2>&1 && cached-zsh-init niri 'command niri completions zsh'

export PATH="/home/toms/.local/bin:$PATH"
export PATH="/home/toms/.bun/bin:$PATH"
export ANDROID_HOME='/opt/android-sdk/'
export NDK_HOME='/opt/android-ndk/'
export PATH=$PATH:/opt/android-sdk/cmdline-tools/latest/bin
export PATH="/home/toms/.bun/bin:$PATH"
export PATH=$PATH:/home/toms/.turso
export PATH=$PATH:/home/toms/.local/bin/
export PATH=$PATH:/home/toms/.cargo/bin/
export PATH=$PATH:/home/toms/.local/share/nvim/mason/bin/
export PATH=$PATH:/home/toms/.deno/bin
export PATH=$PATH:/var/lib/flatpak/exports/share
export PATH=$PATH:/home/toms/.local/share/flatpak/exports/share
export XDG_DATA_DIRS=/var/lib/flatpak/exports/share
export XDG_DATA_DIRS=$XDG_DATA_DIRS:/home/toms/.local/share/flatpak/exports/share
export XDG_DATA_DIRS=$XDG_DATA_DIRS:/usr/share
export KUBECONFIG=/home/toms/.kube/config
export TERMINAL=ghostty
export RIPGREP_CONFIG_PATH=/home/toms/.config/ripgrep/config
export VCPKG_ROOT="/home/toms/vcpkg"
alias source-me="source ~/.zshrc"
alias lsa="eza --long --all --icons=always --git --time-style=long-iso --octal-permissions --no-user"
alias lsas="eza --long --all --icons=always --git --time-style=long-iso --octal-permissions --no-user --total-size"
alias ls="eza"
alias cat="bat"
alias nvim-new="ghostty -e nvim"
alias p="pi --no-session --model openai-codex/gpt-5.4-mini --thinking off --no-tools --no-extensions --no-skills --no-themes --no-prompt-templates -p $@"
alias pinvim="pi --model openai-codex/gpt-5.5 --thinking low --append-system-prompt '<CRITICAL>Be extremely precise: only make the exact changes the user explicitly requests. Do not expand into unrelated files or add extra modifications. In this IDE setup, avoid any changes outside the user-specified scope. It is ok to leave broken state as we are working on incremental changes and will resolve any conflicts or compile errors eventually. If the requested changes span more files than the user requests, point that out in the response but do not peform any additional changes without explicit user confirmation. Reread state between user messages as the user will make manual edits - these manual edits NEED to be preserved unless the users asks them to be changed. Do not make style changed unless the user explicitly asks.</CRITICAL>'"

ob-edit() {
    cd ~/obsidian/tomstoms/
    $EDITOR
  }

secret-init() {
  pass-cli login

  eval "$(ssh-agent -s)"

  pass-cli item view --vault-name "Personal" --item-title "lenovo l13 private key" --output json | jq -r ".item.content.note" | ssh-add -
  pass-cli item view --vault-name "Personal" --item-title "advangrid-ssh" --output json | jq -r ".item.content.note" | ssh-add -
  pass-cli item view --vault-name "Personal" --item-title "advangrid pandora-admin" --output json | jq -r '.item.content.extra_fields.[] | select(.name == "private").content.Text' | ssh-add -

  export OPENCODE_ZEN_API_KEY="$(pass-cli item view --vault-name "Personal" --item-title "OPENCODE_ZEN_API_KEY" --output json | jq -r '.item.content.note')"
  export TAVILY_API_KEY="$(pass-cli item view --vault-name "Personal" --item-title "TAVILY_API_KEY" --output json | jq -r '.item.content.note')"
  export OPENROUTER_API_KEY="$(pass-cli item view --vault-name "Personal" --item-title "OPENROUTER_API_KEY" --output json | jq -r '.item.content.note')"
  export MINIMAX_API_KEY="$(pass-cli item view --vault-name "Personal" --item-title "MINIMAX_API_KEY" --output json | jq -r '.item.content.note')"
  export ZAI_API_KEY="$(pass-cli item view --vault-name "Personal" --item-title "ZAI_API_KEY" --output json | jq -r '.item.content.note')"
  export QWENCLOUD_TOKEN_PLAN_API_KEY="$(pass-cli item view --vault-name "Personal" --item-title "QWENCLOUD_TOKEN_PLAN_API_KEY" --output json | jq -r '.item.content.note')"

  local adv_prod_mysql_uri
  adv_prod_mysql_uri="$(pass-cli item view --vault-name "Personal" --item-title "ADV_PROD_MYSQL_URI" --output json | jq -r '.item.content.note')"
  local adv_prod_mysql_uri_pattern='^mysql://([^:]+):([^@]+)@([^:]+):([0-9]+)/([^?]+)(\?.*)?$'

  if [[ "$adv_prod_mysql_uri" =~ $adv_prod_mysql_uri_pattern ]]; then
    export ADV_PROD_MYSQL_USER="${match[1]}"
    export ADV_PROD_MYSQL_PWD="${match[2]}"
    export ADV_PROD_MYSQL_HOST="${match[3]}"
    export ADV_PROD_MYSQL_PORT="${match[4]}"
  else
    print -u2 "Failed to parse ADV_PROD_MYSQL_URI"
    return 1
  fi
}

z() {
  secret-init
  zellij "$@"
}

 k3s-local() {
   case "$1" in
     up|start)
       echo "Starting iSCSI daemon..."
       sudo systemctl start iscsid.service

       echo "Starting k3s..."
       sudo systemctl start k3s.service

       echo "Cluster status:"
       sudo systemctl --no-pager --full status iscsid.service k3s.service
       ;;

     down|stop)
       echo "Stopping k3s..."
       sudo systemctl stop k3s.service

       if [[ -x /usr/local/bin/k3s-killall.sh ]]; then
         echo "Cleaning up k3s containers, networking, and mounts..."
         sudo /usr/local/bin/k3s-killall.sh
       fi

       echo "Stopping iSCSI daemon..."
       sudo systemctl stop iscsid.service

       echo "Clearing stale iSCSI unit failures..."
       sudo systemctl reset-failed iscsi.service iscsid.socket iscsid.service

       echo "Cluster stopped."
       ;;

     status)
       sudo systemctl --no-pager --full status k3s.service iscsid.service iscsi.service iscsid.socket
       ;;

     disable-autostart)
       echo "Disabling k3s and iSCSI autostart..."
       sudo systemctl disable k3s.service
       sudo systemctl disable iscsi.service iscsid.socket iscsid.service
       sudo systemctl reset-failed iscsi.service iscsid.socket iscsid.service
       ;;

     *)
       echo "Usage: k3s-local {up|down|status|disable-autostart}"
       return 2
       ;;
   esac
 }

export PNPM_HOME="$HOME/.local/share/pnpm"

# pnpm v11 installs global executables in $PNPM_HOME/bin. Keep the
# legacy pnpm <=10 bin directory ($PNPM_HOME) out of PATH.
typeset -U path PATH
path=("$PNPM_HOME/bin" "${(@)path:#$PNPM_HOME}")

command -v wt >/dev/null 2>&1 && cached-zsh-init wt 'command wt config shell init zsh'

command -v pulumi >/dev/null 2>&1 && cached-zsh-init pulumi 'command pulumi completion zsh'


# ---------------------------------------------------------------------------
# orp-cleanup: find and remove orphaned advangrid dev environments.
#
# When herdr closes a workspace/pane it can leave behind:
#   - detached tmux sessions (advangrid-<slot>) running dev servers/watchers
#   - docker compose projects (advangrid-<slot>) with ~7 containers each
#   - slot state dirs ($XDG_STATE_HOME/advangrid-dev/<slot>) and named volumes
#
# A tmux session is "orphaned" when no live herdr workspace references its
# worktree (fallback: no attached client, when herdr is unavailable). A
# compose project or state dir is orphaned when its slot has no surviving
# tmux session.
#
# Usage: orp-cleanup [-n|--dry-run] [-y|--yes]
orp-cleanup() {
  local dry_run=0 assume_yes=0
  while (( $# )); do
    case "$1" in
      -n|--dry-run) dry_run=1 ;;
      -y|--yes)     assume_yes=1 ;;
      -h|--help)    print -r -- 'Usage: orp-cleanup [-n|--dry-run] [-y|--yes]'; return 0 ;;
      *)            print -u2 -- "orp-cleanup: unknown option: $1"; return 2 ;;
    esac
    shift
  done

  local state_root="${XDG_STATE_HOME:-$HOME/.local/state}/advangrid-dev"
  local -a live_worktrees orphan_sessions orphan_projects orphan_state vols nets
  local -a sorted_slots sorted_res_slots
  local -A live_slots orphan_slots orphan_res_slots
  local session project slot cwd attached d orphan stub rc=0

  # Live herdr workspaces (preferred liveness signal).
  if (( $+commands[herdr] && $+commands[jq] )); then
    live_worktrees=(${(f)"$(herdr workspace list 2>/dev/null \
      | jq -r '.result.workspaces[] | .worktree.checkout_path // empty' 2>/dev/null)"})
  fi

  # 1. tmux sessions advangrid-<slot> orphaned by closed herdr workspaces.
  if (( $+commands[tmux] )); then
    for session in ${(f)"$(tmux list-sessions -F '#S' 2>/dev/null)"}; do
      [[ "$session" == advangrid-<-> ]] || continue
      slot="${session#advangrid-}"
      orphan=0
      if (( ${#live_worktrees} )); then
        cwd="$(tmux list-panes -t "$session" -F '#{pane_current_path}' 2>/dev/null | head -n 1)"
        if [[ -z "$cwd" || " ${live_worktrees[*]} " != *" $cwd "* ]]; then
          orphan=1
        fi
      else
        attached="$(tmux display-message -p -t "$session" '#{session_attached}' 2>/dev/null)"
        [[ "$attached" == "0" ]] && orphan=1
      fi
      if (( orphan )); then
        orphan_sessions+=("$session")
        orphan_slots[$slot]=1
      else
        live_slots[$slot]=1
      fi
    done
  fi

  # 2. docker compose projects advangrid-<slot> with no surviving tmux session.
  if (( $+commands[docker] )); then
    for project in ${(f)"$(docker ps -a \
        --filter label=com.docker.compose.project \
        --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | sort -u)"}; do
      [[ "$project" == advangrid-<-> ]] || continue
      slot="${project#advangrid-}"
      (( ${live_slots[$slot]:-0} )) && continue
      orphan_projects+=("$project")
      orphan_slots[$slot]=1
    done
  fi

  # 2b. leftover volumes/networks carrying an advangrid-<slot> project label
  # (containers and state dirs may already be gone).
  if (( $+commands[docker] )); then
    for project in ${(f)"$( {
        docker volume ls --filter label=com.docker.compose.project --format '{{.Label "com.docker.compose.project"}}'
        docker network ls --filter label=com.docker.compose.project --format '{{.Label "com.docker.compose.project"}}'
      } 2>/dev/null | sort -u)"}; do
      [[ "$project" == advangrid-<-> ]] || continue
      slot="${project#advangrid-}"
      (( ${live_slots[$slot]:-0} )) && continue
      orphan_res_slots[$slot]=1
      orphan_slots[$slot]=1
    done
  fi

  # 3. leftover slot state dirs whose containers are long gone.
  if [[ -d "$state_root" ]]; then
    for d in "$state_root"/<->(N/); do
      slot="${d:t}"
      (( ${live_slots[$slot]:-0} )) && continue
      orphan_state+=("$d")
      orphan_slots[$slot]=1
    done
  fi

  if (( ! ${#orphan_sessions} && ! ${#orphan_projects} && ! ${#orphan_state} && ! ${#orphan_res_slots} )); then
    print -r -- "orp-cleanup: no orphaned advangrid dev environments found."
    return 0
  fi

  print -r -- "Orphaned advangrid dev environments:"
  (( ${#orphan_sessions} )) && print -r -- "  tmux sessions:   ${(j: :)orphan_sessions}"
  (( ${#orphan_projects} )) && print -r -- "  docker projects: ${(j: :)orphan_projects}"
  (( ${#orphan_state} ))    && print -r -- "  state dirs:      ${(j: :)orphan_state}"
  # (zsh key-sort flags are unreliable here; sort slot numbers explicitly)
  (( ${#orphan_slots} ))     && sorted_slots=(${(f)"$(print -l -- ${(k)orphan_slots} | sort -n)"})
  (( ${#orphan_res_slots} )) && sorted_res_slots=(${(f)"$(print -l -- ${(k)orphan_res_slots} | sort -n)"})
  (( ${#sorted_res_slots} )) && print -r -- "  vols/nets only:  slots ${(j: :)sorted_res_slots}"
  (( ${#sorted_slots} ))     && print -r -- "  slots:           ${(j: :)sorted_slots}"

  if (( dry_run )); then
    print -r -- "Dry run; nothing removed."
    return 0
  fi

  if (( ! assume_yes )); then
    read -q "reply?Remove all of the above? [y/N] " || { print; return 1; }
    print
  fi

  stub=""
  if (( ${#orphan_projects} )); then
    stub="$(mktemp /tmp/orp-cleanup-compose.XXXXXX.yaml)"
    print -r -- 'services: {}' > "$stub"
  fi

  for session in "${orphan_sessions[@]}"; do
    print -r -- "killing tmux session $session"
    tmux kill-session -t "$session" || rc=1
  done

  # 'down' locates containers/networks via the compose project label; the stub
  # file only satisfies the CLI's requirement for a config file.
  for project in "${orphan_projects[@]}"; do
    print -r -- "tearing down docker project $project"
    docker compose -p "$project" -f "$stub" down --remove-orphans --timeout 5 || rc=1
  done

  # Named volumes/networks aren't declared in the stub, so remove them by label.
  if (( $+commands[docker] )); then
    for slot in "${sorted_slots[@]}"; do
      vols=(${(f)"$(docker volume ls -q --filter "label=com.docker.compose.project=advangrid-$slot" 2>/dev/null)"})
      if (( ${#vols} )); then
        print -r -- "removing volumes: ${(j: :)vols}"
        docker volume rm "${vols[@]}" || rc=1
      fi
      nets=(${(f)"$(docker network ls -q --filter "label=com.docker.compose.project=advangrid-$slot" 2>/dev/null)"})
      if (( ${#nets} )); then
        print -r -- "removing network:  advangrid-$slot default"
        docker network rm "${nets[@]}" >/dev/null || rc=1
      fi
    done
  fi

  for d in "${orphan_state[@]}"; do
    print -r -- "removing state dir $d"
    rm -rf -- "$d" || rc=1
  done

  [[ -n "$stub" ]] && rm -f "$stub"
  return $rc
}

# Entire CLI shell completion
autoload -Uz compinit && compinit && source <(entire completion zsh)
