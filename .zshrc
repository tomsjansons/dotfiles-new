# Added by ForgeCode installer
export PATH="/home/toms/.local/bin:$PATH"
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

alias lazynvim='NVIM_APPNAME=nvimlazy nvim'
export EDITOR='nvim'
export VISUAL='ghostty -e nvim'

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
alias p="pi --no-session --model openai-codex/gpt-5.4-mini --thinking off --no-tools --no-extensions --no-skills --no-themes --no-prompt-templates -p $@"
alias pinvim="pi --model openai-codex/gpt-5.5 --thinking low --append-system-prompt '<CRITICAL>Be extremely precise: only make the exact changes the user explicitly requests. Do not expand into unrelated files or add extra modifications. In this IDE setup, avoid any changes outside the user-specified scope. It is ok to leave broken state as we are working on incremental changes and will resolve any conflicts or compile errors eventually. If the requested changes span more files than the user requests, point that out in the response but do not peform any additional changes without explicit user confirmation. Reread state between user messages as the user will make manual edits - these manual edits NEED to be preserved unless the users asks them to be changed. Do not make style changed unless the user explicitly asks.</CRITICAL>'"

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

export PNPM_HOME="/home/toms/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac

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


