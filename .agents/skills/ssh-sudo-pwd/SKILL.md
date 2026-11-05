---
name: ssh-sudo-pwd
description: SSH into a remote VM and run sudo commands without leaking the sudo password into prompts, argv, or LLM context. The password comes from T3 Code's request_secret tool (file delivery) or, in a plain terminal session, from a <VAR>_SUDO_PWD env var. Use when a task requires running sudo commands on a remote VM, or when the user says "use bash ssh", "use <VAR>_SUDO_PWD", or mentions a remote host needing sudo access.
---

# SSH + sudo without leaking the password

## 1. Get the password

You never see the password and never type it. Pick the source:

- **T3 Code (`request_secret` tool available):** call it with `delivery: "file"`, a label naming the host (e.g. `sudo password for app-vm`), and a one-line reason. It returns a private file path. Only the path appears in your commands; the shell reads the value from the file.
- **Terminal session:** the user exported an env var before starting the agent (e.g. `SUDO_PWD`, `APPVM_SUDO_PWD`). Use the name they gave you.
- **Neither:** stop and ask. Don't invent a third way (no asking for it in chat, no writing it to a file yourself).

If the user declines the secret card, stop. Don't retry the request unprompted.

Each Bash call starts from a clean shell, and a T3 secret is meant for one use. **Do all sudo work for one task in a single Bash call**, normally one `bash -s` heredoc (form B below). If a later call needs sudo again, check the file still exists (`test -s "$f"`); if it's gone, call `request_secret` again.

Every command starts with this preamble. Exactly one of the first two lines is used:

```bash
pw="$(cat -- '/path/from/request_secret')" || exit 2   # T3 Code
pw="${SUDO_PWD:-}"                                     # terminal
test -n "$pw" || exit 2
```

`$pw` is a plain shell variable: not exported, gone when the call ends. From here on the two sources are identical.

## 2. Run the command

**A. One-shot command:**

```bash
<preamble>
printf '%s\n' "$pw" | timeout 60 ssh -o BatchMode=yes -o ConnectTimeout=15 user@host \
  "sudo -S -p '' bash -lc 'systemctl status myservice --no-pager'"
```

**B. Multi-step script (the default for anything beyond one command):**

```bash
<preamble>
{ printf '%s\n' "$pw"; cat <<'EOF'
set -u
cd /tmp || exit 1   # sudo -u keeps our cwd; leave the login user's home first
systemctl status myservice.service --no-pager || true
sudo -u appuser -- git -C /srv/app/repo rev-parse HEAD || true
EOF
} | timeout 120 ssh -o BatchMode=yes -o ConnectTimeout=15 user@host 'sudo -S -p "" bash -s'
```

How it works:
- `sudo -S` reads the password from the first line of stdin, so it never shows up in `ps`, shell history, or the ssh command line. The rest of stdin is the script for `bash -s`.
- `-p ''` suppresses sudo's prompt so it doesn't pollute output.
- Quote the heredoc delimiter (`<<'EOF'`) so nothing in the script expands locally.
- Inside the script you're already root, so nested `sudo -u appuser -- cmd` needs no password.
- Add `|| true` to inspection commands so one failed probe doesn't abort the script.
- Prefer `sudo -u appuser -- cmd` over root where possible. For `systemctl --user` / `journalctl --user` add `env XDG_RUNTIME_DIR=/run/user/$(id -u appuser)`.

## Running as another user (`sudo -u someuser`)

`sudo -u someuser -- cmd` does **not** change the working directory. The child keeps the caller's cwd, usually the login user's home. If that home isn't traversable by `someuser` (e.g. mode `0700`), you get `Permission denied` even though sudo authenticated fine.

- `cd /tmp` (or a directory `someuser` owns) first, as in form B.
- Prefer explicit paths over cwd: `git -C /srv/app/repo`, `find /srv/app ...`.
- For the target user's home or login env: `sudo -u someuser -i -- cmd`, or `sudo -u someuser -- env HOME=/home/someuser cmd`. Don't assume `~` resolves to their home.
- Diagnose with `sudo -u someuser -- pwd`, which prints the inherited cwd.

## Password hygiene

- The value only ever travels as `printf '%s\n' "$pw" |` into ssh's stdin. Nowhere else.
- Never `echo`, `cat`, or `printf` the password or the secret file to the terminal, even "to check it". To verify it loaded, use `test -n "$pw"`.
- Never interpolate `$pw` into a command string: `ssh host "... '$pw' ..."` expands locally and puts the password in ssh's argv. The same goes for building a remote command with `"$(...)"` around it.
- Never copy the secret file, write the password to a local or remote file, or `export` it.
- Use `printf '%s\n'`, not `echo`: echo can mangle backslashes and leading dashes.

## Fallbacks

- **Check whether sudo needs a password at all.** No secret needed, so do this before asking for one:
  ```bash
  timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=10 user@host "sudo -n true && echo SUDO_CACHED || echo SUDO_NEEDS_PASSWORD"
  ```
  If it prints `SUDO_CACHED`, skip the secret and use `sudo -n`.
- **Force fresh authentication** (cached timestamp stale): add `-k` → `sudo -S -k -p ''`.
- **Long local script file:** stream it after the password instead of uploading it:
  ```bash
  <preamble>
  { printf '%s\n' "$pw"; cat /tmp/probe.sh; } | timeout 200 ssh -o BatchMode=yes user@host 'sudo -S -p "" bash -s'
  ```
- **TTY mode** (`ssh -tt`): only when a remote command truly needs a pty. A pty echoes stdin, which can print the password into output, so avoid feeding the password through it. Prefer `-S -p ''` without a tty.

## Host setup

Host, user, and env var name come from the user or the project docs. Use `~/.ssh/config` aliases when given. Always pass `-o BatchMode=yes -o ConnectTimeout=10` (or 15) and wrap in `timeout 20`–`200` so nothing hangs.

## Guardrail: account lockout

The remote may lock the account after failed sudo attempts (e.g. faillock).
- The preamble's `test -n "$pw" || exit 2` keeps a missing secret from burning an attempt.
- If sudo rejects the password, **stop and tell the user**. Don't retry, and don't request the secret again on your own: a mistyped password typed twice is two strikes.
- Use `sudo -k` only when you know the password is correct.
