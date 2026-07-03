# pulse — fleet monitoring platform

Design doc, 2026-07-03. Status: **milestone 1 built** — the platform (service +
schema + ingest/query API + VPN-only manifests + Angular UI + Android wrapper) is
scaffolded and green. Milestones 2+ (the Mac producer with `--json` emitters and
the launchd pusher) are not yet built; see §9.

## 1. Goal

A single mobile-friendly place to see all system and code health/status knowledge
for the fleet, from any VPN device. Long term it is the central custom monitoring
platform: everything the CLI scripts print today (`fleet_health.py`, `doc_checks.py`,
`~/Code/check`, per-repo verify gates) plus future producers, rendered as tiles,
bullet lists, and charts.

Two roles, deliberately separated:

- **Producers** — anything that can run a check and POST JSON. First producer is the
  Mac mini running the existing tools on a timer. Later: amun/isis/odin themselves,
  odin backup jobs, in-cluster jobs.
- **The platform (`pulse`)** — one k3s service on isis that ingests reports, stores
  history, and serves the UI. It knows nothing about *what* is being checked; it
  renders whatever verdict-shaped data arrives. Adding a new producer requires zero
  service changes.

### Non-goals (v1)

- No alerting / push notifications. It is a pull-based dashboard; dead-man alerting
  stays on healthchecks.io. (Future: pulse itself could notify, or expose its own
  dead-man state to healthchecks.)
- No remote command execution — strictly ingest + display. The service never reaches
  out to the fleet (it can't reach the Mac anyway; the Mac is a one-way VPN peer).
- No metric-scraping agents (node_exporter etc.). Producers are our own tools.
- No auth UI. VPN + source-range whitelist gates reads; a bearer token gates writes.

## 2. Why custom (alternatives considered)

- **Prometheus + Grafana**: our data is *verdict-shaped* (pass/fail/warn with
  observed/expected strings and doc refs), not metric-shaped; the pull model can't
  reach the one-way Mac; and Grafana Cloud's public-dashboard limits already bit us.
  The existing tools are check-runners, not exporters — bending them into metrics
  loses exactly the part we like (the labelled ✓/✗ lines with context).
- **healthchecks.io**: only liveness of jobs, no content.
- **Extending home.xinutec.org**: home is public-by-design and sensor-focused;
  monitoring state is fleet-internal and belongs behind the VPN.

Custom service, common libraries (axum, sqlx, Angular Material, a small chart lib),
same stack as the rest of the fleet so `~/Code/check` keeps it consistent.

## 3. Existing landscape (what feeds this)

| Tool | Lives | Checks | Output today |
|---|---|---|---|
| `fleet_health.py` | `xinutec-infra/mac-mini/` | hosts, k3s pods, backups+drills, restic, TLS/DNS, blocklists, healthchecks.io, VPN one-way, git drift | ANSI text, exit code |
| `doc_checks.py` | `xinutec-infra/mac-mini/` | documented claims vs live fleet, each with `file:line` ref | ANSI text, exit code |
| `~/Code/check` (`dev_lint.fleet`) | dev-lint engine + `~/Code/check` config | fleet consistency, per-repo dev-lint, per-repo `verify.sh` (`--full`) | ANSI text, exit code |
| `dev-lint` | `~/Code/dev-lint` | per-file `path:line:col: RULE msg` | text, exit code |

None emit JSON today, but all hold structured data in memory
(`CheckResult(section, label, verdict, observed, expected)` in `_checks.py`;
`Finding`/`Run` tuples in `fleet.py`; `Violation` dataclass in dev-lint). The
emitters are serializers, not parsers — no text-scraping anywhere in this design.

## 4. Data model

### 4.1 Report schema (the wire format, `schema: 1`)

```jsonc
{
  "schema": 1,
  "id": "01J...",              // ULID minted by the producer (idempotency key)
  "collector": "fleet-health", // which tool produced this
  "collected_at": "2026-07-03T14:00:00Z",  // producer clock, start of run
  "duration_ms": 84211,
  "interval_s": 3600,          // producer's own declared cadence → staleness
  "checks": [
    {
      "section": "isis",              // grouping, mirrors the CLI section headers
      "label": "disk usage /",        // STABLE key part — must not embed values
      "subject": "isis",              // optional: which host/repo this is ABOUT
      "verdict": "pass",              // pass | fail | warn | skip
      "observed": "43% used",         // free text, mirrors CLI detail
      "expected": "< 85%",            // optional free text
      "value": 43.0, "unit": "%",     // optional numeric → trend charts
      "ref": "backups.md:57",         // optional doc/source reference
      "detail": "…"                   // optional multi-line drill-down text
    }
  ]
}
```

Notes on the shape — each of these is a deliberate decision:

- **`source` is not in the body.** The ingest token *is* the identity: the server
  maps token → source name and stamps it server-side. A compromised or buggy
  producer cannot spoof another machine's status.
- **Check identity for trends** is `(source, collector, section, label)`. This is a
  *contract on producers*: labels must be stable across runs, with run-varying data
  in `observed`/`value`, never in the label. `_checks.py` already separates label
  from observed. `fleet.py` does **not** (consistency findings are free-form
  messages) — see §7.3 for the required refactor.
- **`subject`** exists because tools report *about* machines they don't run on
  (`fleet_health.py` runs on the Mac, reports about odin). It enables a future
  "everything about isis" view regardless of which producer said it.
- **One optional numeric per check.** A check needing several numbers is several
  checks. Keeps charting trivial.
- **`interval_s` self-declares cadence** so staleness needs no server-side config:
  the last report's declared interval drives the overdue computation. A producer
  that changes cadence updates it with its next report.
- **`collected_at` vs `received_at`**: both stored. The spool (§7.2) means uploads
  can arrive late; producer clocks can skew. Truth-time is `collected_at`;
  `received_at` is diagnostic.
- **Report-level `ok` is derived** (no check has verdict `fail`), never sent.
- **`schema` version field** from day one; the server rejects unknown versions
  rather than guessing.

### 4.2 Database (MariaDB, own instance, `life` pattern)

```
report   id (ULID pk), source, collector, schema, collected_at, received_at,
         duration_ms, interval_s, ok (derived), raw (LONGTEXT, the payload)
check    report_id (fk), seq, section, label, subject, verdict,
         observed, expected, value, unit, ref, detail,
         -- denormalized for the trend query, avoids the join:
         source, collector, collected_at
token    (none — tokens live in the k8s secret as env, see §6)
```

Indexes: `report(source, collector, collected_at)`;
`check(source, collector, section, label, collected_at)` for history;
`check(verdict, collected_at)` for the problems view.

**Volume estimate**: ~200 checks/report × hourly × 3 collectors ≈ 15–20k check
rows/day, ~7M/year — comfortable for MariaDB with the above indexes. Raw payloads
(~100 KB each) are the real weight: ~5–7 MB/day, ~2.5 GB/year.

**Retention** (background task, daily): raw payloads pruned after **30 days**
(kept that long for schema-evolution replays and debugging); `check` rows after
**400 days** (a year of trends + margin); `report` summary rows kept forever
(they're tiny and answer "how long has this been running").

## 5. API

All under `/api`, plus `/healthz`. Types shared Rust→TS via ts-rs (life pattern).

| Route | Purpose |
|---|---|
| `POST /api/reports` | Ingest. `Authorization: Bearer <token>`. 201 on store, **200 on duplicate `id`** (idempotent replay from the spool), 401 bad token, 422 bad schema. |
| `GET /api/overview` | Sources × collectors: latest verdict rollup, check counts by verdict, `collected_at`, staleness state. The home-screen query. |
| `GET /api/problems` | All checks with verdict fail/warn from each collector's *latest* report, plus overdue collectors. "What's wrong right now." |
| `GET /api/reports?source&collector&limit` | Report list (history of runs). |
| `GET /api/reports/:id` | One report with all checks, grouped by section — the CLI-output-mirror view. |
| `GET /api/history?source&collector&section&label&from&to` | Time series for one check: `(collected_at, verdict, value)` tuples. Feeds sparklines/charts and "since when is this red". |

Ingest validation is strict (unknown verdicts, missing fields, unknown `schema` →
422 with a reason). Producers are ours; failing loudly beats storing junk.

### Staleness (first-class)

A push-based monitor's worst failure mode is a dead producer looking green. The
overview computes, per (source, collector):

- `fresh` — age ≤ 1.5 × `interval_s`
- `overdue` (rendered as warn) — age ≤ 3 × `interval_s`
- `silent` (rendered as fail) — age > 3 × `interval_s`

Staleness is computed at read time from the last report — no cron, no server
config. A source that has *never* reported is unknown to pulse; the eventual
guard for "expected producers exist" is a `doc_checks.py`-style check (a producer
asserting the producer list — turtles, but it works and it's one more check row).

## 6. Service: `pulse` on isis

Stack: **Rust axum + MariaDB + Angular 22 zoneless**, cloned from the `life`
skeleton (main/lib split, `routes/` layer, sqlx migrations, ts-rs types, three-stage
Dockerfile → `xinutec/pulse:latest`, nonroot 65532, read-only rootfs, tight
requests/limits).

k8s (`code/kubes/pulse/k8s/`, numbered like life):

- `00-namespace` `01-pvc` (5 Gi) `02-db` (mariadb:11.8, Recreate, hardened)
  `03-app` `04-ingress` `05-networkpolicy` (db-from-app-only) + `secret.sh`.
- **VPN-only** exactly like messages: DNS `A pulse → 10.100.0.2`
  (`proxied = false`, in `code/dns/xinutec_org.tf`, copy the `org_messages`
  block) + cert-manager issuer **`letsencrypt-dns`** (DNS-01; the ClusterIssuer +
  cloudflare token secret already exist on isis from messages — reuse, don't
  recreate).
- Additionally set `nginx.ingress.kubernetes.io/whitelist-source-range:
  "10.100.0.0/24"` on the ingress. messages documents this as untested (unclear
  whether client source IPs survive k3s servicelb) — pulse is the low-stakes place
  to finally test it. If source IPs don't survive, drop the annotation and we're
  at messages-parity (DNS-only concealment); the write path is still token-gated
  either way.

**Ingest tokens**: env var in the k8s secret, `PULSE_TOKENS="mac-mini:<random>"`
(comma-separated `source:token` pairs), generated by `secret.sh` from
`/dev/urandom` like life's secrets. No token table, no management UI; adding a
producer = edit secret + rollout. Constant-time comparison on the server. On the
Mac the token lives in a `0600` file under `~/.config/pulse/`, read by the pusher
— never in a repo, never in launchd plist XML.

**Reads are unauthenticated** (VPN + whitelist is the gate — user decision:
view-only fleet status, login friction not worth it). Writes need the token.

CI: a `pulse` job in `.github/workflows/build.yml` calling the shared `docker.yml`
(path `code/kubes/pulse`, image `pulse`), gated on verify jobs like messages.
Deploy stays manual `kubectl apply` on isis (isis is not Flux-managed).

## 7. First producer: the Mac mini

Three parts, all in `xinutec-infra/mac-mini/` next to the tools they wrap.

### 7.1 `--json` emitters

- **`_checks.py`** grows a `--json` mode used by both `fleet_health.py` and
  `doc_checks.py`: serialize `Checker.results` (`CheckResult` →
  check objects; `Verdict` → lowercase strings) plus run metadata into the §4.1
  report shape. One shared implementation, ~30 lines. The existing human output is
  untouched; `--json` writes the report to stdout (or `--json-out FILE`).
- **`dev_lint/fleet.py`** grows `--json` similarly: `Run(name, status, detail)` →
  one check per repo per stage (section `lint` / `verify`, label = repo name,
  `value` = violation count where parseable, `detail` = captured output);
  consistency findings → section `consistency` (see 7.3).
- **dev-lint itself gets no emitter in v1** — `fleet.py` already captures its
  per-repo output and count; per-violation structure can come later if the
  drill-down wants it.

### 7.2 `pulse_push.py` (spool + upload)

```
pulse_push.py run <collector> -- <command...>   # run tool, capture JSON, spool, flush
pulse_push.py flush                             # retry everything in the spool
```

- Runs the collector with `--json`, stamps `id` (ULID) + `duration_ms`, writes the
  report to `~/.local/state/pulse/spool/<id>.json`, then attempts upload of every
  spooled file to `https://pulse.xinutec.org/api/reports`; deletes on 2xx
  (200-duplicate counts as success — that's the idempotency working).
- Survives isis downtime, VPN flaps, and Mac sleep: nothing is lost, order doesn't
  matter, `collected_at` stays true. At-least-once + server dedupe on `id` =
  effectively exactly-once.
- A run whose collector *crashes* (non-zero exit and no JSON) spools a synthetic
  single-check report (`section: collector, verdict: fail, detail: stderr tail`) —
  the platform must show tool breakage, not go silent.

### 7.3 `fleet.py` stable-key refactor (prerequisite, small)

Consistency findings today are `(level, "free-form message with specifics")` —
unusable as trend keys. Before the emitter lands, each consistency check gets a
stable id (it already has a function name) and findings carry
`(check_id, repo, message)` so the JSON maps to
`section="consistency", label=check_id, subject=repo, observed=message`. Human
output unchanged. This is the only producer-side refactor the design needs.

### 7.4 Schedule (launchd)

| Collector | Cadence | Note |
|---|---|---|
| `fleet_health.py` | hourly | network probes, ~1–2 min |
| `doc_checks.py` | every 6 h | claims drift slowly |
| `check` (consistency + lint) | every 6 h | minutes of dev-lint across repos |
| `check --full` | daily, overnight | builds + full test suites |

One launchd plist per cadence invoking `pulse_push.py run …`. **Known risk to
verify at implementation time**: the tools SSH to the fleet hosts; they must find
keys non-interactively in a launchd context (no Keychain-unlocked ssh-agent). If
that bites, the fallback is running the pushes from a login-session LaunchAgent
rather than a LaunchDaemon.

## 8. UI

Angular 22 zoneless + Angular Material (M3 tokens per the DL-SCSS rules), signals,
mobile-first. Served single-origin by the axum binary; Android single-WebView
wrapper at `code/kubes/pulse/android/` (`org.xinutec.pulse`, hardcoded
`PULSE_URL`, recall `#android` nix shell, `deploy.sh` sideload) — identical to
life's wrapper.

Views, in the order you'd reach for them:

1. **Overview** (home) — one tile per (source, collector): worst-verdict colour,
   pass/warn/fail counts, "12 min ago" freshness, overdue/silent badge. Everything
   green fits on one phone screen.
2. **Problems** — flat list of every current fail/warn across all collectors +
   overdue producers, each linking into its report context. The "something's red,
   what is it" view; arguably the real home screen when it's non-empty.
3. **Collector detail** — the latest report rendered as the CLI renders it:
   sections, ✓/✗/⚠ lines, observed/expected, `ref` shown as `file:line`. Familiar
   by construction. Each check line links to its history.
4. **Check history** — verdict timeline strip ("red since Tuesday 14:00") and, for
   checks with `value`, a line chart (disk %, cert days, snapshot count,
   violation counts trending to zero).
5. **Runs** — report list per collector with duration + ok, for "did it even run".

Charts: sparklines in tiles are hand-rolled SVG (trivial, no dep); the history
view uses a small self-contained chart lib — decide at implementation after
checking what health-sync's frontend already uses (reuse beats introducing a
second lib; if none fits, Chart.js).

## 9. Milestones

1. **Platform skeleton** — `code/kubes/pulse/` cloned from life: schema,
   migrations, ingest + all five GET routes, token auth, retention task, tests
   (`tests/` public-API style), verify.sh, k8s manifests, DNS record, CI job.
   Deployed and accepting `curl` reports. Add `pulse` to `~/Code/check` REPOS.
2. **Mac producer** — `_checks.py --json`, `fleet.py` stable keys + `--json`,
   `pulse_push.py`, launchd timers. Real data flowing.
3. **UI core** — overview, problems, collector detail. Android wrapper. This is
   the point it replaces squinting at a terminal.
4. **History** — timeline strips + charts + runs view.
5. **More producers** (open-ended) — odin backup job reports, amun/isis
   in-cluster checks, anything else; zero service changes by design.

## 10. Open questions / risks

- **whitelist-source-range vs servicelb** — does the client IP survive? Test on
  pulse first (§6). Either outcome is acceptable; token still gates writes.
- **launchd + SSH keys** for non-interactive fleet probes (§7.4).
- **`fleet.py` key refactor** touches dev-lint's engine — small but it's shared
  infrastructure; do it as its own reviewed commit with tests.
- **Label stability is a convention, not enforced.** A producer that embeds a
  value in a label silently forks its own history. Mitigation: a dev-lint rule is
  overkill for now; instead the history view makes breakage visible (series
  stops), and emitter tests pin the label sets.
- **Clock skew**: `collected_at` is producer-stamped; the Mac is NTP-synced so
  this is theoretical, but the phone-mic lesson says record `received_at` anyway
  (done, §4.1).
