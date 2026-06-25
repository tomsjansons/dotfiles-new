HISTFILE=~/.histfile
HISTSIZE=1000
SAVEHIST=1000
unsetopt beep
bindkey -v

bindkey "^[[H" beginning-of-line
bindkey "^[[F" end-of-line
bindkey "^[[3~" delete-char
bindkey "^[[1;5D" backward-word
bindkey "^[[1;5C" forward-word

# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

source /usr/share/zsh-theme-powerlevel10k/powerlevel10k.zsh-theme
source /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
source /usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

export PNPM_HOME="$HOME/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac

# source /usr/share/cachyos-zsh-config/cachyos-config.zsh
if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate zsh)"
fi
# eval "$(obsidian-cli completion zsh)"
source <(fzf --zsh)

export EDITOR='nvim'


# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# . "$HOME/.local/bin/env"

# Hermes Agent — ensure ~/.local/bin is on PATH
export PATH="$HOME/.local/bin:$PATH"


alias source-me="source ~/.zshrc"
alias lsa="eza --long --all --icons=always --git --time-style=long-iso --octal-permissions --no-user"
alias lsas="eza --long --all --icons=always --git --time-style=long-iso --octal-permissions --no-user --total-size"
alias ls="eza"
alias cat="bat"


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

ob-edit() {
    cd ~/obsidian/tomstoms/
    $EDITOR
}

zst () {
  secret-init
  zellij -l welcome
}


if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi

if command -v pulumi >/dev/null 2>&1; then eval "$(command pulumi completion zsh)"; fi
