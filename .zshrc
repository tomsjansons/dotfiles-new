
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

# Directory of this .zshrc, symlinks resolved. Sibling dotfiles (.zsh-secrets,
# .zsh-k3s, .zsh-orp-cleanup) are sourced from here, so any deployment layout
# works: stow to ~, ZDOTDIR elsewhere, or a plain copy.
_zshrc_dir="${${(%):-%N}:A:h}"

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

# --- secrets (pass-cli + kernel keyring cache) ------------------------------
# Everything secrets-related lives in .zsh-secrets next to this file.
[[ -r "$_zshrc_dir/.zsh-secrets" ]] && source "$_zshrc_dir/.zsh-secrets"

# --- k3s local cluster helper ------------------------------------------------
# See .zsh-k3s next to this file.
[[ -r "$_zshrc_dir/.zsh-k3s" ]] && source "$_zshrc_dir/.zsh-k3s"

export PNPM_HOME="$HOME/.local/share/pnpm"

# pnpm v11 installs global executables in $PNPM_HOME/bin. Keep the
# legacy pnpm <=10 bin directory ($PNPM_HOME) out of PATH.
typeset -U path PATH
path=("$PNPM_HOME/bin" "${(@)path:#$PNPM_HOME}")

command -v wt >/dev/null 2>&1 && cached-zsh-init wt 'command wt config shell init zsh'

command -v pulumi >/dev/null 2>&1 && cached-zsh-init pulumi 'command pulumi completion zsh'


# --- orp-cleanup: remove orphaned advangrid dev environments -----------------
# See .zsh-orp-cleanup next to this file.
[[ -r "$_zshrc_dir/.zsh-orp-cleanup" ]] && source "$_zshrc_dir/.zsh-orp-cleanup"

# Entire CLI shell completion
autoload -Uz compinit && compinit && source <(entire completion zsh)
