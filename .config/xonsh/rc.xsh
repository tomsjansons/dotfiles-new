import shlex

execx($(mise activate xonsh))

$EDITOR='nvim'

@aliases.register
def _ob_edit():
    cd ~/obsidian/tomstoms/
    $[ @(shlex.split($EDITOR)) ]


@aliases.register
def _pass_agent():
    pass-login

    eval "$(ssh-agent -s)"

    pass-cli item view --vault-name "Personal" --item-title "lenovo l13 private key" --output json | jq -r ".item.content.note" | ssh-add -
    pass-cli item view --vault-name "Personal" --item-title "advangrid-ssh" --output json | jq -r ".item.content.note" | ssh-add -
    pass-cli item view --vault-name "Personal" --item-title "advangrid pandora-admin" --output json | jq -r '.item.content.extra_fields.[] | select(.name == "private").content.Text' | ssh-add -
