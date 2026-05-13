# Grafana — custom resources

Local copy of the **custom** dashboards/alerts/contact-points in
`toktok.grafana.net`. Cloud-managed integration dashboards
(`GrafanaCloud/*`, `Integration - Linux Node/*`, `Integration - Grafana
Agent`) are deliberately **not tracked here** — they are maintained by
Grafana Cloud and would fight any `grr apply` from this repo.

## Tool

[`grizzly`](https://github.com/grafana/grizzly) (`grr`) — pulled in via
`nix-shell -p grizzly`. Wraps the Grafana HTTP API and applies YAML
resource files declaratively.

## Auth

- Service account: `claude-code` (Editor role) in `Main Org.`
- Token file: `~/.config/grafana/toktok-token` (symlink on Mac mini;
  real file on each server) — the underlying file is in this same
  repo at `.config/grafana/toktok-token`, encrypted via git-crypt.

## Workflow

```sh
./sync.sh diff        # show what would change
./sync.sh apply       # push local YAML to Grafana
./sync.sh pull Dashboard <uid>   # pull one resource from Grafana
```

`grr` reads `GRAFANA_URL` + `GRAFANA_TOKEN` from the environment; the
wrapper exports them from the token file. Run from anywhere — `sync.sh`
`cd`s to its own directory first.

## What's tracked

- `dashboards/picade-monitoring.yaml` — public view on Picade metrics.

Future additions:
- Custom fleet-overview dashboards
- Grafana-managed alert rules (the `grr` Kind is `AlertRuleGroup`)
- Real contact points (Pushover, Matrix, Signal — whatever wins the
  "page me at 03:00" criterion)

## What's deliberately NOT tracked

- Cloud-managed integration dashboards under
  `GrafanaCloud/`, `Integration - Linux Node/`, `Integration - Grafana
  Agent/`
- All 12 Grafana Cloud data sources (Prometheus, Loki, Tempo, etc.) —
  Cloud-provisioned, no benefit to mirroring
- The placeholder `email receiver` contact point pointing at
  `<example@email.com>` — to be replaced with a real one, not preserved
- The default global alert notification policy — to be replaced
- Prometheus-side rule groups (Mimir) — would need a separate Mimir
  tenant-id + API key; we'd manage those separately if/when we add
  them

## Re-pulling the full Cloud state for inspection

```sh
mkdir -p /tmp/grafana-snapshot && cd /tmp/grafana-snapshot
GRAFANA_URL=https://toktok.grafana.net \
GRAFANA_TOKEN="$(cat ~/.config/grafana/toktok-token)" \
nix-shell -p grizzly --run 'grr pull -e .'
```

Don't commit those to the repo — they'd start fighting Grafana Cloud's
updates.
