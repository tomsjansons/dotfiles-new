#!/usr/bin/env bash
set -u
set -o pipefail

# Update Arch/metapac packages one by one, reviewing AUR PKGBUILD changes with `p` first.
#
# Flow:
#   1. Read package names from .config/metapac/groups/all.toml's arch section.
#   2. For each installed package with an available update:
#      - repo package: update with paru directly.
#      - AUR package: fetch/update the PKGBUILD clone, diff it against the previous local clone,
#        ask `p` to review the diff, and skip/package for manual review if suspicious.
#   3. Append suspicious/skipped AUR updates to manual-review.md.
#
# The AI review is intentionally conservative. If the review is not clearly SAFE, the package is skipped.

METAPAC_FILE="${METAPAC_FILE:-.config/metapac/groups/all.toml}"
MANUAL_REVIEW_FILE="${MANUAL_REVIEW_FILE:-manual-review.md}"
CLONE_DIR="${PARU_CLONE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/paru/clone}"
WORK_DIR="${TMPDIR:-/tmp}/paru-pkgbuild-review.$$"
P_CMD="${P_CMD:-p}"

# Set DRY_RUN=1 to print actions without installing updates.
DRY_RUN="${DRY_RUN:-0}"

mkdir -p "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

require_cmd paru
require_cmd awk
require_cmd git
require_cmd diff

if [[ ! "$P_CMD" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "error: P_CMD must be a simple command or alias name, got: $P_CMD" >&2
  exit 1
fi

if [[ ! -f "$METAPAC_FILE" ]]; then
  echo "error: metapac file not found: $METAPAC_FILE" >&2
  exit 1
fi

extract_arch_packages() {
  awk '
    /^arch[[:space:]]*=[[:space:]]*\{[[:space:]]*packages[[:space:]]*=/ { in_arch=1 }
    in_arch {
      line=$0
      sub(/[[:space:]]*#.*/, "", line)
      while (match(line, /"([^"\\]|\\.)*"/)) {
        pkg=substr(line, RSTART + 1, RLENGTH - 2)
        print pkg
        line=substr(line, RSTART + RLENGTH)
      }
      if (line ~ /\][[:space:]]*\}/) in_arch=0
    }
  ' "$METAPAC_FILE"
}

is_repo_package() {
  pacman -Si "$1" >/dev/null 2>&1
}

has_update() {
  paru -Quq "$1" 2>/dev/null | grep -Fxq "$1"
}

current_version() {
  paru -Q "$1" 2>/dev/null | awk '{print $2}'
}

available_version() {
  paru -Qu "$1" 2>/dev/null | awk '{print $4; exit}'
}

append_manual_review() {
  local pkg="$1"
  local old_ver="$2"
  local new_ver="$3"
  local reason="$4"
  local diff_file="$5"
  local ts
  ts="$(date -Is)"

  {
    echo
    echo "## $pkg ($ts)"
    echo
    echo "- Installed version: ${old_ver:-unknown}"
    echo "- Available version: ${new_ver:-unknown}"
    echo "- Decision: skipped"
    echo
    echo "### Reason"
    echo
    echo '```text'
    printf '%s\n' "$reason"
    echo '```'

    if [[ -s "$diff_file" ]]; then
      echo
      echo "### PKGBUILD diff"
      echo
      echo '```diff'
      cat "$diff_file"
      echo '```'
    fi
  } >> "$MANUAL_REVIEW_FILE"
}

call_prompt_checker() {
  local prompt="$1"
  local review_file="$2"
  local alias_line alias_body alias_expanded
  local -a alias_words
  if command -v "$P_CMD" >/dev/null 2>&1; then
    "$P_CMD" "$prompt" > "$review_file"
    return
  fi

  # `p` is often a shell alias, and aliases are not visible to non-interactive scripts.
  # Ask the user's shell for the alias, parse the trusted local alias body, then call it.
  if [[ -n "${SHELL:-}" ]] && alias_line="$("$SHELL" -ic "alias $P_CMD" 2>/dev/null)"; then
    alias_body="${alias_line#*=}"
    if [[ -n "$alias_body" && "$alias_body" != "$alias_line" ]]; then
      eval "alias_expanded=$alias_body"
      eval "alias_words=($alias_expanded)"
      "${alias_words[@]}" "$prompt" > "$review_file"
      return
    fi
  fi

  echo "error: $P_CMD is not an executable and was not found as an alias in ${SHELL:-the current shell}" >&2
  return 127
}

review_pkgbuild_diff() {
  local pkg="$1"
  local old_ver="$2"
  local new_ver="$3"
  local diff_file="$4"
  local review_file="$5"

  local prompt
  prompt="You are reviewing an Arch/AUR PKGBUILD diff before updating package '$pkg' from '${old_ver:-unknown}' to '${new_ver:-unknown}'.

Look for malicious or suspicious changes, especially:
- new or changed install scripts, hooks, systemd units, cron jobs, shell profile edits, or autostart files
- network downloads added outside normal source= handling
- curl/wget/bash/python/ruby/node one-liners, encoded payloads, obfuscation, eval, base64, chmod +x, sudo, su, chown, setcap
- code that reads or exfiltrates secrets, SSH/GPG keys, browser profiles, password stores, tokens, wallets, or home-directory data
- changed source URLs, checksums disabled with SKIP, unexpected binary blobs, vendored artifacts, or install-time telemetry
- maintainer-like changes that are unrelated to packaging/version bumps

Return exactly this format:
VERDICT: SAFE or SUSPICIOUS
REASON: one concise paragraph

If there is any meaningful uncertainty, choose SUSPICIOUS.

PKGBUILD diff:
$(cat "$diff_file")"

  call_prompt_checker "$prompt" "$review_file"
}

update_package() {
  local pkg="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] paru -S --needed --noconfirm $pkg"
  else
    paru -S --needed --noconfirm "$pkg"
  fi
}

review_and_update_aur_package() {
  local pkg="$1"
  local old_ver new_ver cache_pkg before_dir after_dir diff_file review_file verdict reason
  old_ver="$(current_version "$pkg")"
  new_ver="$(available_version "$pkg")"
  cache_pkg="$CLONE_DIR/$pkg"
  before_dir="$WORK_DIR/$pkg.before"
  after_dir="$WORK_DIR/$pkg.after"
  diff_file="$WORK_DIR/$pkg.diff"
  review_file="$WORK_DIR/$pkg.review"

  rm -rf "$before_dir" "$after_dir" "$diff_file" "$review_file"

  if [[ -d "$cache_pkg/.git" ]]; then
    cp -a "$cache_pkg" "$before_dir"
  fi

  echo "Fetching latest PKGBUILD for $pkg..."
  if ! paru -G --redownload --skipreview "$pkg" >/dev/null 2>&1; then
    local msg="Failed to fetch latest PKGBUILD with paru -G. Package was not updated."
    echo "  suspicious/needs review: $msg"
    : > "$diff_file"
    append_manual_review "$pkg" "$old_ver" "$new_ver" "$msg" "$diff_file"
    return 0
  fi

  if [[ ! -d "$cache_pkg" ]]; then
    local msg="PKGBUILD clone was not found at $cache_pkg after paru -G. Package was not updated."
    echo "  suspicious/needs review: $msg"
    : > "$diff_file"
    append_manual_review "$pkg" "$old_ver" "$new_ver" "$msg" "$diff_file"
    return 0
  fi

  cp -a "$cache_pkg" "$after_dir"

  if [[ -d "$before_dir" ]]; then
    diff -ruN \
      --exclude='.git' \
      --exclude='src' \
      --exclude='pkg' \
      "$before_dir" "$after_dir" > "$diff_file" || true
  else
    {
      echo "No previous local PKGBUILD clone existed for $pkg. Full fetched packaging files follow."
      diff -ruN --exclude='.git' /dev/null "$after_dir/PKGBUILD" 2>/dev/null || true
      find "$after_dir" -maxdepth 1 -type f ! -name '.SRCINFO' ! -name 'PKGBUILD' -print0 \
        | sort -z \
        | while IFS= read -r -d '' f; do diff -u /dev/null "$f" || true; done
    } > "$diff_file"
  fi

  if [[ ! -s "$diff_file" ]]; then
    echo "  no PKGBUILD diff for $pkg; updating."
    update_package "$pkg"
    return 0
  fi

  echo "Reviewing PKGBUILD diff for $pkg with $P_CMD..."
  if ! review_and_output_err="$(review_pkgbuild_diff "$pkg" "$old_ver" "$new_ver" "$diff_file" "$review_file" 2>&1)"; then
    local msg="AI PKGBUILD review command failed. Output: $review_and_output_err"
    echo "  suspicious/needs review: $msg"
    append_manual_review "$pkg" "$old_ver" "$new_ver" "$msg" "$diff_file"
    return 0
  fi

  verdict="$(grep -Eim1 '^VERDICT:[[:space:]]*(SAFE|SUSPICIOUS)' "$review_file" | sed -E 's/^VERDICT:[[:space:]]*//I' | tr '[:lower:]' '[:upper:]')"
  reason="$(sed -n -E 's/^REASON:[[:space:]]*//Ip' "$review_file" | head -n1)"
  [[ -n "$reason" ]] || reason="$(cat "$review_file")"

  if [[ "$verdict" == "SAFE" ]]; then
    echo "  review verdict: SAFE; updating $pkg."
    update_package "$pkg"
  else
    echo "  review verdict: ${verdict:-unknown}; skipping $pkg."
    append_manual_review "$pkg" "$old_ver" "$new_ver" "$reason" "$diff_file"
  fi
}

main() {
  local pkg total=0 updated_or_checked=0 skipped_not_installed=0 skipped_no_update=0

  echo "Reading arch packages from $METAPAC_FILE"
  mapfile -t packages < <(extract_arch_packages)
  total="${#packages[@]}"
  echo "Found $total arch packages."

  # Refresh package databases once; individual package installs below stay one-by-one.
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] paru -Sy"
  else
    paru -Sy
  fi

  for pkg in "${packages[@]}"; do
    [[ -n "$pkg" ]] || continue
    echo
    echo "==> $pkg"

    if ! paru -Qq "$pkg" >/dev/null 2>&1; then
      echo "  not installed; skipping."
      skipped_not_installed=$((skipped_not_installed + 1))
      continue
    fi

    if ! has_update "$pkg"; then
      echo "  no update available; skipping."
      skipped_no_update=$((skipped_no_update + 1))
      continue
    fi

    updated_or_checked=$((updated_or_checked + 1))

    if is_repo_package "$pkg"; then
      echo "  repository package; updating one-by-one with paru."
      update_package "$pkg"
    else
      echo "  AUR/PKGBUILD package; checking PKGBUILD diff before update."
      review_and_update_aur_package "$pkg"
    fi
  done

  echo
  echo "Done."
  echo "Packages in manifest: $total"
  echo "Packages with updates processed: $updated_or_checked"
  echo "Skipped because not installed: $skipped_not_installed"
  echo "Skipped because no update: $skipped_no_update"
  echo "Suspicious/failed reviews, if any, were appended to: $MANUAL_REVIEW_FILE"
}

main "$@"
