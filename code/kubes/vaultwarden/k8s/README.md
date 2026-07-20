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
2. **Quiesce both sides** (Recreate strategy, single writer):
   ```
   # isis
   kubectl -n vaultwarden scale deploy/vaultwarden --replicas=0
   # amun
   ssh root@amun 'kubectl -n vaultwarden scale deploy/vaultwarden --replicas=0'
   ```
3. **Copy the data** amun -> isis. Resolve each PVC's backing dir first:
   ```
   AMUN_DIR=$(ssh root@amun "ls -d /var/lib/rancher/k3s/storage/*vaultwarden-data*")
   ISIS_DIR=$(ssh root@isis "ls -d /var/lib/rancher/k3s/storage/*vaultwarden-data*")
   ssh root@amun "tar -C \"$AMUN_DIR\" -cf - ." | ssh root@isis "tar -C \"$ISIS_DIR\" -xf -"
   ```
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
   Flux stops reconciling it. (Removing it from Flux BEFORE cutover would prune
   the running amun instance — don't.)

## Retiring Flux entirely

`cert-dns` (the amun `letsencrypt-dns` issuer) is already superseded on isis by
the shared cluster issuer, so once vaultwarden is off amun, the whole
`xinutec/fleet` repo + the four Flux controllers on amun manage nothing. At that
point Flux can be uninstalled from amun and the repo archived.
