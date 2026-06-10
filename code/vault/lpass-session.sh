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

# Stay unlocked until you explicitly log out or the machine reboots — pippijn
# wants persistent delegated access (Claude manages the account). The key only
# ever lives in the in-memory agent, never on disk; `lpass logout` (or a
# reboot) forgets it immediately. Override e.g. LPASS_AGENT_TIMEOUT=3600 for a
# tighter, self-expiring window.
export LPASS_AGENT_TIMEOUT="${LPASS_AGENT_TIMEOUT:-0}"   # 0 = until logout/reboot
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
if [ "$LPASS_AGENT_TIMEOUT" = "0" ]; then
  echo "session is live and STAYS logged in until 'lpass logout' or reboot."
else
  echo "session is live (timeout ${LPASS_AGENT_TIMEOUT}s)."
fi
echo "Tell Claude to proceed. Revoke any time with:  lpass logout"
