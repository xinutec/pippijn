#!/usr/bin/env bash
# Prove a namespace's NetworkPolicy allow-graph, by connecting.
#
# A NetworkPolicy is an L3/L4 rule, so "can this pod open a TCP connection to
# that address" is the WHOLE of what it decides — which makes it cheap to check
# and pointless to reason about instead. `kubectl get netpol` shows what was
# applied, not what it does; the two came apart the first time this was used
# (`ipBlock` naming the node's own address, which reads correctly and matches
# nothing, because CNI-HOSTPORT-DNAT rewrites the packet first — see
# signal/k8s/05-networkpolicy.yaml).
#
# Run it BEFORE applying a policy and after. Before, everything should be open
# — including the destinations that are supposed to become blocked, which is
# what makes the after-run evidence rather than a coincidence.
#
#   ssh root@isis 'bash -s' < netpol-reach.sh signal
#
# `bash`'s /dev/tcp is the probe because it is the one tool present in every
# image here; curl and nc are not (the two Rust services are distroless-ish and
# have neither).
set -euo pipefail

ns=${1:?usage: netpol-reach.sh <namespace> [table-file]}
table=${2:-}

# Where to exec the probe for a workload name.
#
# ⚠ NOT EVERY WORKLOAD IS A DEPLOYMENT. A CronJob has no long-running pod to
# exec into, and its policy selects on `app=<name>` like any other — so the
# probe needs *a* pod carrying that label. One is created on demand and removed
# on exit. Without this a batch job's rows cannot be probed at all, and a reach
# table row nobody can check is the drift this file exists to prevent.
#
# The image is the fleet archiver's because it is already on the node and has
# bash; the pod runs `sleep` and never the real command.
declare -A ephemeral=()

cleanup() {
	local name
	for name in "${!ephemeral[@]}"; do
		kubectl -n "$ns" delete pod "netpol-probe-$name" --now >/dev/null 2>&1 || true
	done
}
trap cleanup EXIT

# Sets $TARGET rather than printing it. ⚠ NOT a command substitution: that runs
# in a subshell, so `ephemeral` would be recorded in a child and lost — the pod
# gets created once, "already exists" on every row after, and the cleanup trap
# never learns it is there. Which is to say the probe would leak a pod into the
# namespace it is checking.
TARGET=
ensure_target() {
	local name=$1
	if kubectl -n "$ns" get deploy "$name" >/dev/null 2>&1; then
		TARGET="deploy/$name"
		return
	fi
	if [[ -z ${ephemeral[$name]:-} ]]; then
		ephemeral[$name]=1
		kubectl -n "$ns" delete pod "netpol-probe-$name" --now >/dev/null 2>&1 || true
		kubectl -n "$ns" run "netpol-probe-$name" \
			--image=xinutec/signal-archiver:latest \
			--labels="app=$name" --restart=Never \
			--command -- sleep 900 >/dev/null
		kubectl -n "$ns" wait --for=condition=Ready \
			"pod/netpol-probe-$name" --timeout=90s >/dev/null
		wait_for_policy "$name"
	fi
	TARGET="pod/netpol-probe-$name"
}

# ⚠ READY IS NOT ENFORCED. kube-router programmes its ipsets from pod events, so
# for a second or two a brand-new pod egresses as though no policy existed — and
# the FIRST row probed against it comes back `open` whatever the policy says.
#
# That is not hypothetical: the first run of this against a fresh probe pod
# reported 10.100.0.1:2230 open while :22 on the same host, from the same pod,
# was correctly blocked. The difference was which row ran first.
#
# So: poll a destination nothing should ever reach until it is actually blocked,
# and only then start believing the answers. A namespace with no default-deny
# never satisfies this, hence the warning rather than a hang.
wait_for_policy() {
	local name=$1 i
	for i in $(seq 1 30); do
		if ! kubectl -n "$ns" exec "pod/netpol-probe-$name" -- \
			timeout 3 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done
	printf '⚠ %s: egress to 1.1.1.1 never became blocked — either this namespace has no default-deny, or policy is not being enforced. Every `open` below is unproven.\n' \
		"$name" >&2
}

probe() {
	local deploy=$1 host=$2 port=$3 expect=$4 state
	ensure_target "$deploy"
	if kubectl -n "$ns" exec "$TARGET" -- \
		timeout 6 bash -c "exec 3<>/dev/tcp/$host/$port" >/dev/null 2>&1; then
		state=open
	else
		state=blocked
	fi
	[[ $state == "$expect" ]] || rc=1
	printf '%-22s -> %-24s %-5s  %-7s  expect=%s %s\n' \
		"$deploy" "$host" "$port" "$state" "$expect" \
		"$([[ $state == "$expect" ]] && echo OK || echo '<-- MISMATCH')"
}

rc=0
# Rows are `deploy host port open|blocked`, from a file or stdin. Comments and
# blank lines are skipped so a table can be annotated with WHY a row is there —
# which is the half of it a bare address cannot carry.
while read -r deploy host port expect _; do
	# `if`, not `[[ … ]] && continue` — under `set -e` the latter exits the
	# script on every row that is NOT a comment, because a false test is the
	# statement's exit status.
	if [[ -z ${deploy:-} || $deploy == \#* ]]; then
		continue
	fi
	probe "$deploy" "$host" "$port" "$expect"
done < <(if [[ -n $table ]]; then cat "$table"; else cat; fi)

exit $rc
