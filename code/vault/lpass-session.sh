#!/usr/bin/env nix-shell
#!nix-shell -i bash -p lastpass-cli
# Open a LastPass CLI session so automation (Claude) can read/write the
# vault WITHOUT ever seeing the master password — the LastPass analogue of
# vault-session.sh.
#
# LastPass uses a background *agent* rather than a session token: once you
# log in here, every later `lpass` command run as your user reuses the
# cached session until it times out (LPASS_AGENT_TIMEOUT) or you log out.
# Claude therefore just runs `lpass show/ls/add/edit` afterwards — no token
# file to pass around.
#
#   ./lpass-session.sh [email]     # default pip88nl@gmail.com; prompts for
#                                  # master password, then 2FA if enabled
#
# Revoke any time with:  lpass logout      (or wait for the timeout below)
set -euo pipefail

EMAIL="${1:-pip88nl@gmail.com}"

# Keep the vault unlocked long enough to get real work done, then forget.
# Override e.g. LPASS_AGENT_TIMEOUT=3600 for a tighter window, or 0 for
# "until logout/reboot". `lpass logout` kills it immediately.
export LPASS_AGENT_TIMEOUT="${LPASS_AGENT_TIMEOUT:-28800}"   # 8h
# Read the master password from THIS terminal, not a GUI pinentry popup
# (this runs over a `!` shell, where a desktop prompt may never appear).
export LPASS_DISABLE_PINENTRY=1

if lpass status -q 2>/dev/null; then
  echo "already logged in: $(lpass status)"
else
  echo "— LastPass login ($EMAIL): type master password, then 2FA code if prompted —"
  lpass login "$EMAIL"
fi

echo "vault entries: $(lpass ls 2>/dev/null | wc -l | tr -d ' ')"
echo "session is live (timeout ${LPASS_AGENT_TIMEOUT}s). Tell Claude to proceed."
echo "revoke with:  lpass logout"
