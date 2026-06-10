#!/usr/bin/env nix-shell
#!nix-shell -i bash -p bitwarden-cli
# Open a Vaultwarden CLI session and stash the session token in a private
# file, so automation (Claude) can operate on the vault WITHOUT ever seeing
# the master password. Revoke any time with:  bw lock  /  bw logout, or
# just delete ~/.config/bw-session.
set -euo pipefail
umask 077

export BITWARDENCLI_APPDATA_DIR="$HOME/.config/bw-cli"
mkdir -p "$BITWARDENCLI_APPDATA_DIR"

# bw refuses to change the server URL while logged in ("Logout required
# before server config update"), so only set it when actually logged out.
if ! bw login --check >/dev/null 2>&1; then
  bw config server https://vault.xinutec.org >/dev/null 2>&1 || true
  bw login pip88nl@gmail.com
fi
bw unlock --raw > "$HOME/.config/bw-session"
chmod 600 "$HOME/.config/bw-session"
echo "session token written to ~/.config/bw-session (600). Tell Claude to proceed."
