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
#

bindkey "^[[H" beginning-of-line
bindkey "^[[F" end-of-line
bindkey "^[[3~" delete-char
bindkey "^[[1;5D" backward-word
bindkey "^[[1;5C" forward-word


eval "$(oh-my-posh init zsh --config /home/toms/.config/oh-my-posh/amro.omp.json)"
eval $(luarocks path)
eval "$(mise activate zsh)"

source <(fzf --zsh)

source <(jj util completion zsh)

alias lazynvim='NVIM_APPNAME=nvimlazy nvim'
export EDITOR='nvim'
export VISUAL='ghostty -e $EDITOR'

export PATH="$PATH:$(go env GOBIN):$(go env GOPATH)/bin"
export PATH="$PATH:/home/toms/.lmstudio/bin"

source <(niri completions zsh)

export PATH="/home/toms/.bun/bin:$PATH"
export ANDROID_HOME='/opt/android-sdk/'
export NDK_HOME='/opt/android-ndk/'
export PATH=$PATH:/opt/android-sdk/cmdline-tools/latest/bin
export PATH="/home/toms/.bun/bin:$PATH"
export PATH=$PATH:/home/toms/.turso
export PATH=$PATH:/home/toms/.local/bin/
export PATH=$PATH:/home/toms/.local/share/pnpm/
export PATH=$PATH:/home/toms/.cargo/bin/
export PATH=$PATH:/home/toms/.local/share/nvim/mason/bin/
export PATH=$PATH:/home/toms/.local/share/nvimtj/mason/bin/
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

pass-agent() {
  pass-login

  eval "$(ssh-agent -s)"

  pass-cli item view --vault-name "Personal" --item-title "lenovo l13 private key" --output json | jq -r ".item.content.note" | ssh-add -
  pass-cli item view --vault-name "Personal" --item-title "advangrid-ssh" --output json | jq -r ".item.content.note" | ssh-add -
  pass-cli item view --vault-name "Personal" --item-title "advangrid pandora-admin" --output json | jq -r '.item.content.extra_fields.[] | select(.name == "private").content.Text' | ssh-add -
}

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
}

z() {
  secret-init
  zellij "$@"
}

export PNPM_HOME="/home/toms/.local/share/pnpm"

case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end

if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi

if command -v pulumi >/dev/null 2>&1; then eval "$(command pulumi completion zsh)"; fi




# >>> forge initialize >>>
# !! Contents within this block are managed by 'forge zsh setup' !!
# !! Do not edit manually - changes will be overwritten !!

# Add required zsh plugins if not already present
if [[ ! " ${plugins[@]} " =~ " zsh-autosuggestions " ]]; then
    plugins+=(zsh-autosuggestions)
fi
if [[ ! " ${plugins[@]} " =~ " zsh-syntax-highlighting " ]]; then
    plugins+=(zsh-syntax-highlighting)
fi

# Load forge shell plugin (commands, completions, keybindings) if not already loaded
if [[ -z "$_FORGE_PLUGIN_LOADED" ]]; then
    eval "$(forge zsh plugin)"
fi

# Load forge shell theme (prompt with AI context) if not already loaded
if [[ -z "$_FORGE_THEME_LOADED" ]]; then
    eval "$(forge zsh theme)"
fi

# Editor for editing prompts (set during setup)
# To change: update FORGE_EDITOR or remove to use $EDITOR
export FORGE_EDITOR="nvim"
# <<< forge initialize <<<
#

