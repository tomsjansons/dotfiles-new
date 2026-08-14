---
name: ssh-sudo-pwd
description: SSH into a remote VM and run sudo commands using the sudo password provided in the shell environment, without leaking the password into prompts or LLM context. Use when a task requires running sudo commands on a remote VM, or when the user says "use bash ssh", "use <VAR>_SUDO_PWD", or mentions a remote host needing sudo access.
---

# SSH + sudo with env password

## The winning pattern

The sudo password is already available as an **environment variable** in your shell. Never type it, never `echo` it into a prompt, never pass it as an argument — reference it only via the variable name inside the remote command.

**Canonical form — one-shot command (most common):**

```bash
test -n "${SUDO_PWD:-}" || exit 2
printf '%s\n' "$SUDO_PWD" | ssh user@host.example.com "sudo -S -p '' bash -lc '...'"
```

**Canonical form — multi-line script (when you need many steps):**

```bash
test -n "${SUDO_PWD:-}" || exit 2
{ echo "$SUDO_PWD"; cat <<'EOF'
set -u
cd /tmp || exit 1   # target user inherits OUR cwd; leave the login user's home first
cd /srv/app        # or go straight to a dir the target user owns
systemctl status myservice.service --no-pager || true
sudo -u appuser -- git -C /srv/app/repo rev-parse HEAD || true
EOF
} | ssh user@host.example.com 'sudo -S -p "" -u appuser bash -s' 2>/dev/null
```

Key mechanics:
- `sudo -S` reads the password from **stdin** — so it never appears in `ps`, shell history, or the SSH command line.
- `-p ''` (or `-p ""`) suppresses sudo's password prompt so it doesn't pollute stdout.
- `test -n "${VAR:-}" || exit 2` fails fast if the env var isn't set (avoids a silent sudo prompt hang).
- Guard every command with `|| true` when inspecting — a failing probe shouldn't abort the whole script.
- Use `sudo -u appuser -- <cmd>` to run as the service user rather than root where possible; add `env XDG_RUNTIME_DIR=/run/user/$(id -u appuser)` for `systemctl --user` / `journalctl --user`.

## Running as another user (`sudo -u someuser`)

`sudo -u someuser -- cmd` does **not** change the working directory — the child process keeps the cwd of the calling shell (usually the login user's home). If that home dir is not traversable by `someuser` (e.g. a `0700` home), you get **`Permission denied`** even though sudo authenticated fine.

- **Fix: switch cwd to a directory `someuser` can access first** — either `cd /tmp && sudo -u someuser -- ...` or `cd` as the first line inside the `bash -s` heredoc (see canonical example above).
- If the tool takes an explicit path, prefer that over cwd tricks: `git -C /srv/app/repo`, `find /srv/app ...`, `podman --root /srv/app/...`.
- If you need the target user's home or login env, use `sudo -u someuser -i -- cmd` (login shell) or set it explicitly: `sudo -u someuser -- env HOME=/home/someuser cmd`. Don't assume `~` resolves to their home under `sudo -u`.
- Diagnose with `sudo -u someuser -- pwd` — it prints the *inherited* cwd; if that path is unreadable to them, that's your `Permission denied`.

## Password hygiene — never leak the secret

- **Never** paste the actual password into a command, a file, or any prompt. Only the variable name (e.g. `$SUDO_PWD`) ever appears in what you write.
- **Never** `echo "$SUDO_PWD"` without a redirection — the value lands in the transcript.
- The **only** acceptable uses of the variable: inside the `printf '%s\n' "$VAR" |` pipe, or `<<< "$VAR"` heredoc feeding stdin. Both keep it out of argv and out of any visible output.
- If you catch yourself about to inline a literal password, stop — that's the anti-pattern. Use the env var.
- `printf '%s\n'` (not `echo`) avoids mangling passwords with special chars / backslash escapes.
- Never write the password into a remote temp file in cleartext; if you must pass it to a remote script, pass it as `$1` at the end of the remote command so it stays off the command line of the *local* shell (it will briefly be in the remote argv — acceptable, it never leaves the VM).

## Alternatives / fallbacks

- **Non-interactive check** (does sudo need a password at all?):
  ```bash
  timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=10 user@host "sudo -n true && echo SUDO_CACHED || echo SUDO_NEEDS_PASSWORD"
  ```
- **Force a fresh prompt** (cached creds may be stale/expired):
  ```bash
  # use `sudo -k` to invalidate the timestamp before the sudo -S call
  echo "$SUDO_PWD" | ssh user@host "sudo -S -k -p '' sh -c '...'"
  ```
- **TTY mode** (`ssh -tt`) — only when sudo genuinely needs a pty (rare for `-S`; prefer `-S -p ''`). If you must, feed stdin with a heredoc and always add `</dev/null` so it can't hang waiting for a password:
  ```bash
  timeout 60 ssh -tt -o ConnectTimeout=15 user@host 'sudo -S -p "" bash /tmp/probe.sh' </dev/null 2>&1 | tail -n 50
  ```
- **Long scripts over plain ssh** — base64-upload to /tmp, run with sudo:
  ```bash
  B64=$(base64 -w0 /tmp/probe.sh)
  ssh user@host "echo $B64 | base64 -d > /tmp/probe.sh && chmod +x /tmp/probe.sh && printf '%s\n' '$SUDO_PWD' | sudo -S -p '' bash /tmp/probe.sh"
  ```
  Clean up the remote file afterwards.

## Host setup

The exact host, user, and env var name come from the user or the project docs — the pattern is identical regardless. Use `~/.ssh/config` host aliases when given. Always use `-o BatchMode=yes -o ConnectTimeout=10/15` and wrap in `timeout 20-200` to avoid hangs.

## Guardrail: account lockout

The user may have a **failed-attempt lockout** on sudo (e.g. faillock). So:
- Always `test -n "${VAR:-}" || exit 2` first — a missing var is not worth burning an attempt.
- If a sudo call fails, **stop and re-check the env var / connection** rather than blindly retrying repeatedly.
- Use `sudo -k` deliberately to reset cache only when you know the password is correct.
