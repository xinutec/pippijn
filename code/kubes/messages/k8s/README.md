# messages — what its Secret needs beyond keys

`messages-secret` lives in the `signal` namespace (a `secretKeyRef` cannot cross
namespaces) and holds the session key and the Nextcloud OAuth2 client; the keys
are the model's (`dhall/apps/messages.dhall`, `origins`). The database
credentials come from `signal-secret` beside it, not duplicated. Register the
OAuth2 client first in Nextcloud admin (dash → Settings → Security → OAuth 2.0)
with redirect URI `https://messages.xinutec.org/auth/callback`, then give its id
and secret to `plan-run secrets --values`.

Two things are deliberately NOT keys in `messages-secret`, each a credential to
something else with its own lifetime, so rotating the session secret touches
neither.

## The send key: its own Secret, before the manifest that mounts it

⚠ The pod will not start without this Secret: a missing secret volume leaves it
Pending. So this comes BEFORE the manifest that mounts it, the opposite order
from the importer, where a missing key only meant an hourly job that failed.

```sh
ssh-keygen -t ed25519 -N '' -C messages-irc-send -f /root/messages-irc-send
ssh-keyscan -p 2230 10.100.0.1 > /root/messages_irc_known_hosts
kubectl -n signal create secret generic messages-irc-send \
  --from-file=id_ed25519=/root/messages-irc-send \
  --from-file=known_hosts=/root/messages_irc_known_hosts
```

Authorised on the far side, pinned to sending and nothing else:

```sh
printf 'command="/home/irssi/bin/irc-send",restrict %s\n' \
  "$(cat /root/messages-irc-send.pub)" | ssh irc 'cat >> ~/.ssh/authorized_keys'
```

There is nothing to say about who it may talk to. An open tab IS the
permission: the plugin asks irssi whether it has a window item for the target,
so what the app can message is exactly what Pippijn could have typed into.
Closing a tab revokes and opening a query grants, with nothing to edit and
nothing to reload. Fail-closed twice over: a target with no open tab is refused
by irssi, and the app addresses conversations by their id in the archive, so one
that no import has seen yet cannot be named at all.

## The transcriber's token: its own Secret, shared with the Mac

recall's transcriber presents it; the same value goes into the Mac agent that
runs recall's `runner` against messages (`RECALL_SYNC_TOKEN` there). Optional
for the pod: without it, the transcriber's routes are simply not mounted.

```sh
kubectl -n signal create secret generic messages-transcriber \
  --from-literal=TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
```
