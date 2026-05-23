import os
import shlex
import shutil
import subprocess


def _command_exists(command):
    return shutil.which(command) is not None


def _path_value(path):
    return os.path.expanduser(str(path))


def _prepend_path(path):
    path = _path_value(path)
    $PATH.add(path, front=True, replace=True)


def _append_path(path):
    path = _path_value(path)
    $PATH.add(path, front=False, replace=True)


def _set_env_from_bash(command):
    """Run shell init code in bash and import the resulting environment."""
    env_output = $(bash -lc @(command + '; env -0'))
    for item in env_output.split('\0'):
        if '=' not in item:
            continue
        key, value = item.split('=', 1)
        if key in ('PWD', 'SHLVL', '_'):
            continue
        ${key} = value


# Shell integrations

if _command_exists('luarocks'):
    _set_env_from_bash('eval "$(luarocks path)"')

if _command_exists('mise'):
    execx($(mise activate xonsh))

# fzf and niri zsh integrations do not have direct xonsh equivalents here.
# Keep them in .zshrc; load xonsh-native completion/widgets separately if installed.


$EDITOR = 'nvim'
$VISUAL = 'ghostty -e nvim'
$ANDROID_HOME = '/opt/android-sdk/'
$NDK_HOME = '/opt/android-ndk/'
$XDG_DATA_DIRS = '/var/lib/flatpak/exports/share:/home/toms/.local/share/flatpak/exports/share:/usr/share'
$KUBECONFIG = '/home/toms/.kube/config'
$TERMINAL = 'ghostty'
$RIPGREP_CONFIG_PATH = '/home/toms/.config/ripgrep/config'
$VCPKG_ROOT = '/home/toms/vcpkg'
$PNPM_HOME = '/home/toms/.local/share/pnpm'


# zsh-like history/editing defaults
$HISTFILE = '~/.histfile'
$XONSH_HISTORY_SIZE = (1000, 'commands')
$VI_MODE = True


# PATH entries from .zshrc
go_path = shutil.which('go')
if go_path:
    try:
        go_gobin = subprocess.run([go_path, 'env', 'GOBIN'], check=True, text=True, capture_output=True).stdout.strip()
        go_gopath = subprocess.run([go_path, 'env', 'GOPATH'], check=True, text=True, capture_output=True).stdout.strip()
    except Exception:
        go_gobin = ''
        go_gopath = ''
    if go_gobin:
        _append_path(go_gobin)
    if go_gopath:
        _append_path(os.path.join(go_gopath, 'bin'))

_append_path('/home/toms/.lmstudio/bin')
_prepend_path('/home/toms/.local/bin')
_prepend_path('/home/toms/.bun/bin')
_append_path('/opt/android-sdk/cmdline-tools/latest/bin')
_append_path('/home/toms/.turso')
_append_path('/home/toms/.local/bin/')
_append_path('/home/toms/.cargo/bin/')
_append_path('/home/toms/.local/share/nvim/mason/bin/')
_append_path('/home/toms/.local/share/nvimtj/mason/bin/')
_append_path('/home/toms/.deno/bin')
_append_path('/var/lib/flatpak/exports/share')
_append_path('/home/toms/.local/share/flatpak/exports/share')
_prepend_path($PNPM_HOME)


aliases |= {
    'source-me': 'source ~/.config/xonsh/rc.xsh',
    'lsa': 'eza --long --all --icons=always --git --time-style=long-iso --octal-permissions --no-user',
    'lsas': 'eza --long --all --icons=always --git --time-style=long-iso --octal-permissions --no-user --total-size',
    'ls': 'eza',
    'cat': 'bat',
    'nvim-new': 'ghostty -e nvim',
    'p': 'pi --no-session --model openai-codex/gpt-5.4-mini --thinking off --no-tools --no-extensions --no-skills --no-themes --no-prompt-templates -p @($args)',
    'pinvim': 'pi --model openai-codex/gpt-5.5 --thinking low --append-system-prompt "<CRITICAL>Be extremely precise: only make the exact changes the user explicitly requests. Do not expand into unrelated files or add extra modifications. In this IDE setup, avoid any changes outside the user-specified scope. It is ok to leave broken state as we are working on incremental changes and will resolve any conflicts or compile errors eventually. If the requested changes span more files than the user requests, point that out in the response but do not peform any additional changes without explicit user confirmation. Reread state between user messages as the user will make manual edits - these manual edits NEED to be preserved unless the users asks them to be changed. Do not make style changed unless the user explicitly asks.</CRITICAL>"',
}


@aliases.register
def _ob_edit(args):
    cd ~/obsidian/tomstoms/
    $[ @(shlex.split($EDITOR)) ]


@aliases.register('secret-init')
def _secret_init(args):
    login = subprocess.run(['pass-cli', 'login'], text=True, capture_output=True)
    if login.returncode != 0:
        login_output = login.stdout + login.stderr
        if 'Already authenticated' not in login_output:
            print(login_output, end='')
            return login.returncode
    agent_output = $(ssh-agent -s)
    for statement in agent_output.split(';'):
        statement = statement.strip()
        if statement.startswith('SSH_AUTH_SOCK=') or statement.startswith('SSH_AGENT_PID='):
            key, value = statement.split('=', 1)
            ${key} = value

    pass-cli item view --vault-name Personal --item-title 'lenovo l13 private key' --output json | jq -r '.item.content.note' | ssh-add -
    pass-cli item view --vault-name Personal --item-title advangrid-ssh --output json | jq -r '.item.content.note' | ssh-add -
    pass-cli item view --vault-name Personal --item-title 'advangrid pandora-admin' --output json | jq -r '.item.content.extra_fields.[] | select(.name == "private").content.Text' | ssh-add -

    $OPENCODE_ZEN_API_KEY = $(pass-cli item view --vault-name Personal --item-title OPENCODE_ZEN_API_KEY --output json | jq -r '.item.content.note').strip()
    $TAVILY_API_KEY = $(pass-cli item view --vault-name Personal --item-title TAVILY_API_KEY --output json | jq -r '.item.content.note').strip()
    $OPENROUTER_API_KEY = $(pass-cli item view --vault-name Personal --item-title OPENROUTER_API_KEY --output json | jq -r '.item.content.note').strip()
    $MINIMAX_API_KEY = $(pass-cli item view --vault-name Personal --item-title MINIMAX_API_KEY --output json | jq -r '.item.content.note').strip()
    $ZAI_API_KEY = $(pass-cli item view --vault-name Personal --item-title ZAI_API_KEY --output json | jq -r '.item.content.note').strip()


@aliases.register('z')
def _z(args):
    secret_init_status = _secret_init([])
    if secret_init_status:
        return secret_init_status
    $[zellij @(args)]


@aliases.register('k3s-local')
def _k3s_local(args):
    action = args[0] if args else ''

    if action in ('up', 'start'):
        print('Starting iSCSI daemon...')
        $[sudo systemctl start iscsid.service]

        print('Starting k3s...')
        $[sudo systemctl start k3s.service]

        print('Cluster status:')
        $[sudo systemctl --no-pager --full status iscsid.service k3s.service]

    elif action in ('down', 'stop'):
        print('Stopping k3s...')
        $[sudo systemctl stop k3s.service]

        if os.path.exists('/usr/local/bin/k3s-killall.sh') and os.access('/usr/local/bin/k3s-killall.sh', os.X_OK):
            print('Cleaning up k3s containers, networking, and mounts...')
            $[sudo /usr/local/bin/k3s-killall.sh]

        print('Stopping iSCSI daemon...')
        $[sudo systemctl stop iscsid.service]

        print('Clearing stale iSCSI unit failures...')
        $[sudo systemctl reset-failed iscsi.service iscsid.socket iscsid.service]

        print('Cluster stopped.')

    elif action == 'status':
        $[sudo systemctl --no-pager --full status k3s.service iscsid.service iscsi.service iscsid.socket]

    elif action == 'disable-autostart':
        print('Disabling k3s and iSCSI autostart...')
        $[sudo systemctl disable k3s.service]
        $[sudo systemctl disable iscsi.service iscsid.socket iscsid.service]
        $[sudo systemctl reset-failed iscsi.service iscsid.socket iscsid.service]

    else:
        print('Usage: k3s-local {up|down|status|disable-autostart}')
        return 2


# wt and pulumi only expose zsh completions on this machine; leave those in .zshrc.
