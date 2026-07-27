# vaultwarden on isis

Vaultwarden (password manager), VPN-only at `https://vault.xinutec.org`.
Migrated off Flux (the old `fleet/apps/amun/vaultwarden`) onto the fleet's
standard `sync.sh` deploy convention — isis runs no Flux.

- `00-namespace.yaml` / `01-pvc.yaml` / `02-app.yaml` (deployment + service) /
  `03-ingress.yaml` — applied in order by `sync.sh`.
- `secret.sh` — creates `vaultwarden-admin` (the `/admin` token), generated at
  run time instead of the old SOPS-encrypted `admin-token.enc.yaml`.
- TLS uses the existing cluster-wide `letsencrypt-dns` ClusterIssuer +
  `cloudflare-api-token` (shared with messages/fleetwatch; already on isis).

## First-time cutover from amun (one-time, watched — this is the vault)

The vault DB is ~5.6 MB of sqlite in the PVC and is triply backed up (live +
restic on odin + restic on Mac), so the risk is low, but do it deliberately.

1. **Deploy empty on isis** so local-path provisions the PVC dir:
   ```
   NC_… not needed.  ./secret.sh          # note the printed admin token
   ./sync.sh                              # app comes up with an empty vault
   ```
2. **Suspend Flux on amun FIRST, then quiesce both sides** (Recreate strategy,
   single writer):
   ```
   # amun — without this, Flux reverts the scale-down within ~10 min, restarts
   # vaultwarden, and checkpoints the WAL underneath the copy. That happened on
   # 2026-07-26: the first copy was torn and only caught because the source WAL
   # hashed as e3b0c442… (sha256 of empty) and the checksums disagreed.
   ssh root@amun 'kubectl -n flux-system patch kustomization apps --type=merge \
     -p "{\"spec\":{\"suspend\":true}}"'

   # isis
   kubectl -n vaultwarden scale deploy/vaultwarden --replicas=0
   # amun
   ssh root@amun 'kubectl -n vaultwarden scale deploy/vaultwarden --replicas=0'
   # confirm amun STAYS at zero for a minute before copying
   ```
3. **Copy the data** amun -> isis. Resolve each PVC's backing dir first:
   ```
   AMUN_DIR=$(ssh root@amun "ls -d /var/lib/rancher/k3s/storage/*vaultwarden-data*")
   ISIS_DIR=$(ssh root@isis "ls -d /var/lib/rancher/k3s/storage/*vaultwarden-data*")
   # CLEAR the target first. The empty deploy in step 1 wrote its own db.sqlite3
   # and a -wal; extracting over them can leave a stale WAL belonging to a
   # DIFFERENT database, which sqlite would then try to replay.
   ssh root@isis "rm -rf \"$ISIS_DIR\"/*"
   ssh root@amun "tar -C \"$AMUN_DIR\" -cf - ." | ssh root@isis "tar -C \"$ISIS_DIR\" -xf -"

   # Verify the copy rather than assuming it — compare hashes, not sizes:
   for f in db.sqlite3 db.sqlite3-shm db.sqlite3-wal rsa_key.pem; do
     a=$(ssh root@amun "sha256sum \"$AMUN_DIR/$f\" | cut -c1-16")
     i=$(ssh root@isis "sha256sum \"$ISIS_DIR/$f\" | cut -c1-16")
     [ "$a" = "$i" ] && echo "$f MATCH" || echo "$f MISMATCH"
   done
   ```
   `rsa_key.pem` must come across too — it signs session JWTs; a fresh one
   invalidates every logged-in client.
4. **Bring isis up, verify** (still on the old DNS -> amun, so test in-cluster):
   ```
   kubectl -n vaultwarden scale deploy/vaultwarden --replicas=1
   kubectl -n vaultwarden rollout status deploy/vaultwarden
   # port-forward and confirm the vault unlocks with the master password before cutover
   ```
5. **Cut DNS over** — edit `code/dns/xinutec_org.tf` `org_vault.content`
   from `local.hosts.vpn` (amun 10.100.0.1) to `local.hosts.vpn_isis`
   (isis 10.100.0.2), then `tofu apply`. TTL is 3600s.
6. **Decommission amun's copy** only after the isis instance is confirmed good
   on the live hostname: scale amun's deploy to 0 (leave the data until you're
   sure), then remove `apps/amun/vaultwarden` from the `xinutec/fleet` repo so
   Flux stops reconciling it, and un-suspend the Kustomization from step 2.
   (Removing it from Flux BEFORE cutover would prune the running amun instance
   — don't. Leaving it suspended indefinitely silently stops reconciling
   everything else on amun, so don't do that either.)

7. **Repoint the backup — the vault is not backed up until you do.**
   `nixos-config/machines/odin/backup-prepare.sh` hardcodes BOTH `root@amun.vpn`
   and the literal PVC UUID `pvc-98a35778-…`. isis's PVC has a different UUID, so
   after the move the nightly job keeps snapshotting amun's frozen copy and
   reports success — a silent-stale backup of the password manager. Update the
   host and resolve the dir by glob rather than a pinned UUID, then verify a
   staged snapshot actually appears before considering the migration done.

## Flux retired — DONE 2026-07-27

Carried out as predicted above. **No cluster in the fleet runs Flux any more**;
every manifest everywhere is hand-applied from this tree via `sync.sh` /
`scripts/apply.sh`. This makes the Flux steps in the cutover section above
un-runnable — they are kept as the record of how the move was done.

What was removed from amun: the four controllers, the `flux-system` namespace,
ten CRDs, the cluster-scoped RBAC, the `flux@amun` deploy key (also revoked on
GitHub) and `/root/.config/sops-age-fleet.key`. Flux's final inventory was
exactly two objects — the `letsencrypt-dns` ClusterIssuer and its
`cloudflare-api-token` secret — and **nothing referenced either**: all five amun
certificates issue from `letsencrypt-prod` over HTTP-01, so both were deleted
along with the now-orphaned `letsencrypt-dns` ACME account key.

Sequenced so nothing could hang or prune by surprise: clear the finalizers on
the three Flux CRs, delete the CRs (this deliberately skips prune), delete the
two objects explicitly, then `kubectl delete -f gotk-components.yaml`. Deleting
the namespace first would have stranded the CRs in `Terminating` forever, and
letting the `flux-system` Kustomization prune itself risks the controller
disappearing mid-prune.

Verified after: 25 pods (29 minus the four controllers), pod-for-pod identical
otherwise — including both `vps-*` irssi instances at 0 restarts — all five
certificates still `Ready`, and xinutec.org / nocodb / sinterklaas / mail all
still serving with valid TLS.

Rollback material is at `amun:/root/flux-retirement-20260727/` (ClusterIssuer,
both secrets, the Flux CRs, the deploy key; mode 600). The repo is archived
read-only at `github.com/xinutec/fleet` — see its README for where each piece
went and for the note on the Cloudflare token's three copies.
