import shlex

execx($(mise activate xonsh))

$EDITOR='nvim'

@aliases.register
def _ob_edit():
    cd ~/obsidian/tomstoms/
    $[ @(shlex.split($EDITOR)) ]
