# signal — what its Secret needs beyond keys

The keys are the model's (`dhall/apps/signal.dhall`, `origins`) and `plan-run
secrets` makes the generated ones. What follows is the part a person does, in
this order, because each step has a prerequisite the one before it creates.
`archiver/README.md` in the messages repo is the component map.

## Identities, typed

`SIGNAL_NUMBER` is the linked account's number, read back from the signal-cli
pod after linking (`archiver/README.md`, "Linking"). `IRC_SELF_NICK` and
`IRC_SELF_NICK_ALT` are the nicks whose logged lines are Pippijn's own, the
second being the one irssi falls back to on a second connection; without them
every line reads as somebody else's. `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`
are the application credentials from <https://my.telegram.org>. None of these
is a credential in the generated sense and none is written here: this
repository is public. All four are typed keys, given with `--values`.

## The key that pulls the IRC logs: its own Secret

A credential to another cluster, with a different lifetime from the keys above,
so it is its own Secret rather than a key in `signal-secret`:

```sh
ssh-keygen -t ed25519 -N '' -C irclog-sync -f /root/irclog-sync
ssh-keyscan -p 2230 10.100.0.1 > /root/irclog_known_hosts
kubectl -n signal create secret generic signal-irclog-sync \
  --from-file=id_ed25519=/root/irclog-sync \
  --from-file=known_hosts=/root/irclog_known_hosts
```

Authorised on the far side pinned to reading that one tree. Not `rrsync`, which
is what a `command=` for this would normally be: it is a python3 script and the
irssi image has no python3, so a key pinned to it is inert rather than
restricted. See `kubes/vps/irssi/home/pippijn/bin/irclog-pull`.

```sh
printf 'command="/home/irssi/bin/irclog-pull",restrict %s\n' \
  "$(cat /root/irclog-sync.pub)" | ssh irc 'cat >> ~/.ssh/authorized_keys'
```

Prove it before trusting it; each of these must be refused:

```sh
ssh -i /root/irclog-sync -p 2230 irssi@10.100.0.1 id        # a shell
rsync -e '...' irssi@10.100.0.1:/etc/passwd .               # out of the tree
rsync -e '...' ./anything irssi@10.100.0.1:xinutec/         # a write
```

## Telegram: two different secrets, and only one is a key

`TELEGRAM_API_ID`/`TELEGRAM_API_HASH` identify the APPLICATION and are cheap to
replace. The SESSION, the logged-in account, is a row in the archive's own
database (`telegram_session`), written by `telegram login`; replacing it costs a
Telegram flood wait measured in hours. So it is in no Secret, it is covered by
the database's backup, and it is not something to "just regenerate".

Log in ONCE, interactively: Telegram sends a code to the phone.

⚠ Not `kubectl exec` into the Deployment. That pod refuses to start until a
session exists, deliberately, because a feed which is quietly not logged in
looks exactly like a quiet week; so there is no running container to exec into.
Use a throwaway pod with the same environment.

⚠⚠ And the pod needs egress granted to it first, or it hangs with no
explanation. `default-deny-egress` covers every pod in this namespace and allows
only DNS and in-namespace 3306/8080, so a throwaway pod reaches the database and
NOT Telegram. The feed's own 443 allowance is keyed on `app=signal-telegram`, and
giving the login pod that label is not the answer: the Deployment's ReplicaSet
selects on exactly it, would adopt the orphan pod, see two replicas for one
desired, and delete one, possibly mid-login. Grant it transiently, by the label
`kubectl run` sets, and delete the policy afterwards:

```sh
cat <<'NETPOL' | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: tg-login-egress-internet, namespace: signal}
spec:
  podSelector: {matchLabels: {run: tg-login}}
  policyTypes: [Egress]
  egress:
  - ports: [{port: 443, protocol: TCP}]
    to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except: ["10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","169.254.0.0/16","127.0.0.0/8"]
NETPOL

kubectl -n signal run tg-login -it --rm --restart=Never \
  --image=xinutec/signal-archiver:latest \
  --env=DB_HOST=signal-db --env=DB_NAME=signal \
  --env=DB_USER="$(kubectl -n signal get secret signal-secret -o jsonpath='{.data.DB_USER}' | base64 -d)" \
  --env=DB_PASSWORD="$(kubectl -n signal get secret signal-secret -o jsonpath='{.data.DB_PASSWORD}' | base64 -d)" \
  --env=TELEGRAM_API_ID="$(kubectl -n signal get secret signal-secret -o jsonpath='{.data.TELEGRAM_API_ID}' | base64 -d)" \
  --env=TELEGRAM_API_HASH="$(kubectl -n signal get secret signal-secret -o jsonpath='{.data.TELEGRAM_API_HASH}' | base64 -d)" \
  --command -- telegram login '+31...'

kubectl -n signal delete netpol tg-login-egress-internet
```

The session lands in the database, so the Deployment picks it up on its next
restart and never needs the phone again.

## Rotating the database password

The plan makes a missing `DB_PASSWORD`; it does not change the one MariaDB
holds. Rotating means changing it in MariaDB and removing the key from the
Secret together, or the pod comes back unable to reach a database that is
perfectly healthy.
