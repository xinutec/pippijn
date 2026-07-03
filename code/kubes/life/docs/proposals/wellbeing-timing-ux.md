# Proposal: wellbeing tracking · to-do timing · UI quality

Status: proposal (2026-07-03). Folds into `../design/overview.md` and
`../TODO.md` as increments ship.

Three asks, one plan:

1. **Wellbeing** — track how Pippijn feels on a 5-point scale, entered at
   arbitrary moments (morning ≠ afternoon), with rough per-day history.
2. **To-do timing** — express *when a to-do can start* and *when it's due*,
   integrated with the existing blocked/ready graph rather than bolted on.
3. **UI quality** — one consistent, high-end interaction grammar built from
   standard Material components, replacing the current per-screen improvisation.

They interlock: the timing states and the wellbeing check-in both surface on a
new **Today** landing screen, which is the centrepiece of the UX overhaul.

---

## 1. Wellbeing tracking

### 1.1 Shape

An **entry**, not a daily value: `(recorded_at, score 1–5, optional note)`.
Multiple entries per day are the point — "down in the morning, good in the
afternoon" is two entries. No streaks, no gamification, no prompts/nags;
capture is always user-initiated.

Score semantics (fixed labels, shown in the UI, stored as the integer):

| score | label      | icon (Material)             |
|-------|-----------|------------------------------|
| 1     | awful     | `sentiment_very_dissatisfied` |
| 2     | low       | `sentiment_dissatisfied`      |
| 3     | okay      | `sentiment_neutral`           |
| 4     | good      | `sentiment_satisfied`         |
| 5     | great     | `sentiment_very_satisfied`    |

### 1.2 Entry UX — one tap

The core design constraint is **capture friction**: if logging a mood takes
more than a tap it stops happening. So:

- A **check-in strip**: five large (≥48 px) face buttons in a row. Tapping one
  creates the entry immediately at "now" and confirms with a snackbar
  ("Logged *good* — Add note / Undo"). Note and time adjustment are optional
  follow-ups (bottom sheet), never prerequisites.
- **Backdating**: the entry sheet has a time field (default now) so "this
  morning I felt down" can be logged at 15:00 with a 09:00 timestamp.
  Timepicker granularity: minutes; date defaults to today, changeable.
- Entries are editable (score/note/time) and deletable with Undo, like
  everything else.

The strip lives in two places: at the top of the new **Today** screen (§3.6)
and as the header of the wellbeing history screen.

### 1.3 History UX

- **Day timeline** (primary view): a vertical list of days, newest first; each
  day row shows its entries as time-ordered face icons with times, note
  indicator, tap → edit sheet.
- **Trend strip** (header): the last 14 days as a compact chart — one column
  per day, each entry a dot at its score level (y: 1–5, x: time of day within
  the column). This shows both level and within-day movement at a glance.
- **Rendering**: a small hand-written SVG component using M3 colour tokens.
  Five discrete levels and a handful of dots per day do not justify a charting
  library; none exists in the app today and adding chart.js/echarts for this
  would be the heaviest dependency in the frontend. Revisit only if charts
  multiply (spending, stock levels).
- Colour ramp: `--mat-sys-error` (1) → neutral (3) → `--mat-sys-primary` (5),
  via `color-mix` so it tracks light/dark mode.

### 1.4 Data model

New pure-sync entity following the shopping/todo template exactly
(offline-first matters here — moods get logged on the Tube).

`migrations/0014_wellbeing.sql`:

```sql
CREATE TABLE IF NOT EXISTS wellbeing (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id     VARCHAR(255)    NOT NULL,
    recorded_at DATETIME        NOT NULL,           -- UTC
    score       TINYINT UNSIGNED NOT NULL,          -- 1..5
    note        TEXT            NULL,
    ulid        VARCHAR(26)     NULL,
    rev         BIGINT UNSIGNED NOT NULL DEFAULT 0,
    deleted_at  DATETIME        NULL,
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME        NULL,
    UNIQUE KEY uniq_wellbeing_ulid (ulid),
    INDEX idx_wellbeing_user (user_id),
    INDEX idx_wellbeing_rev  (user_id, rev),
    INDEX idx_wellbeing_time (user_id, recorded_at)
);
```

Wire/RxDB doc: `{ ulid, id, recordedAt (ISO-8601 UTC string), score, note,
rev }`. Client renders in local time. Score range enforced in the RxDB schema
(`minimum: 1, maximum: 5`) and in the push handler.

Plumbing (the 8 standard touch points, all copy-from-shopping):
migration → `WellbeingDoc` in `src/sync/types.rs` → pull/push in
`src/sync/repo.rs` → handlers in `src/routes/sync.rs` → route registration →
`frontend/src/app/sync/wellbeing-store.ts` (schema v0, merge fields
`[recordedAt, score, note]` via `makeConflictHandler`) → feature component +
route → `tests/wellbeing_db.rs` (mirror `tests/sync_db.rs`).

Plus, for consistency with "deletion is restorable": a `Wellbeing` variant in
`ConflictKind` and `TrashKind` (conflict-log visibility + trash restore). No
REST/ts-rs layer, no `ngsw-config.json` change (RxDB owns offline storage).

**Privacy**: wellbeing rows are personal data like everything else in the DB;
nothing new leaves the origin. Test fixtures use synthetic scores/notes only.

### 1.5 Placement

Not a fifth tab. Entry happens on **Today** (the new landing, §3.6); the full
history screen lives in the hamburger menu ("Wellbeing"). If usage shows the
history is visited daily, promote it later — tabs are for daily-driver
screens.

---

## 2. To-do timing

### 2.1 What timing should mean here

The to-do list's existing strength is that it computes **actionability** — the
graph derives `blocked | ready | open` from dependencies. Timing should extend
that same idea, not sit beside it as a dumb date column:

- **`not_before`** (a date): "can't / shouldn't start before". Until that
  date the to-do is **waiting** — the temporal analogue of *blocked*. This is
  also snooze: "not this week" = `not_before: next Monday`. It answers the
  real question the list should answer: *what can I act on right now?*
- **`due`** (a date): "must be done by". Past it the to-do is **overdue**.
  Due-ness is *urgency*, an orthogonal axis to actionability — a to-do can be
  blocked **and** due tomorrow, which is precisely the state that most needs
  surfacing (its *blocker* inherits the pressure).

Both are **dates, not datetimes**. Hour-level scheduling, reminders and alarms
stay delegated to NC Calendar (overview §5) — these fields are list-ordering
and attention metadata, not a scheduler. This keeps the "no scheduling
subsystem in life" boundary intact; a later increment may *additionally*
mirror due-dated to-dos to NC as `VTODO`s via CalDAV, out of scope here.

Considered and deliberately deferred:

- **Lead time** ("takes ~2 days" → derived start-by): real value, but it needs
  honest effort estimates, which decay into noise. Revisit if overdue items
  cluster as "started too late".
- **Soft vs hard deadlines**: one `due` field + visual urgency tiers covers
  it; two kinds of deadline is a taxonomy nobody maintains.
- **Recurrence**: a different feature (template + spawn), not a date field.
  NC Calendar already does recurring reminders.

### 2.2 Derived states

`TodoState` (in `todo-graph.ts`) gains one value:

```
done            status == done
blocked         unmet depends_on (graph, as today)
waiting         not_before > today            ← new
ready / open    as today
```

Precedence: `done → blocked → waiting → ready/open` (an item both dep-blocked
and deferred shows *blocked* — the external gate is the informative one).

Orthogonal **urgency**, derived from `due` for any non-done item:
`overdue | today | soon (≤ 3 days) | none`.

"Today" is the device-local calendar day. The computation depends on a
`today` signal refreshed on app-visibility and a midnight timer, so the list
rolls over without a reload.

### 2.3 List behaviour

- **Sort** (replaces the current done → priority → title):
  1. done last (unchanged)
  2. urgency bucket: overdue → due today → due soon → undated/later
  3. priority (high → medium → low → none, as today)
  4. `due` ascending, then title.
- **Waiting items collapse**: the main list shows only actionable +
  urgent items; waiting to-dos sit in a collapsed "Waiting (N)" section at the
  bottom (expandable). This is the visible payoff of `not_before`: the list
  stops shouting about things that can't be done yet.
- **Chips** (M3 assist-chip styling, replacing ad-hoc pills where touched):
  `overdue 2d` / `due today` (error tint), `due in 3d` (tertiary tint),
  `from Sat` (neutral, waiting). Relative wording everywhere; exact date in
  the detail sheet.
- The **Ready** filter toggle keeps working; waiting items are excluded from
  "ready" by definition.

### 2.4 Edit UX

In the detail sheet (and add form), a "Timing" row with two fields:

- **Due** and **Start** (`not_before`), each a `mat-datepicker` input plus
  one-tap presets: *Today · Tomorrow · Weekend · Next week · Clear*. Presets
  cover ~90 % of entries; the picker is the fallback.
- Guard: `not_before ≤ due` when both set (form-level validation, not DB).

### 2.5 Data changes

- `migrations/0015_todo_timing.sql`:
  `ALTER TABLE todos ADD COLUMN not_before DATE NULL, ADD COLUMN due DATE NULL;`
- Rust: `Todo`/`NewTodo`/`UpdateTodo` + `TodoDoc` gain
  `not_before: Option<String>`, `due: Option<String>` (`YYYY-MM-DD`,
  serde-defaulted); ts-rs regen.
- RxDB: `todo-store.ts` schema **v2 → v3** (migration strategy: default both
  to `null`), `TODO_MERGE_FIELDS` += `notBefore, due` — exactly the priority
  precedent (migration 0010 / schema v2).
- Deploy note: an out-of-date client pushing a full doc without the new fields
  would null them server-side. Single user + SW update-on-visibility makes the
  window tiny; ship backend + frontend in one deploy as usual.

---

## 3. UI quality overhaul

### 3.1 Where the app actually stands

The frontend is architecturally modern (zoneless signals, M3 system tokens,
offline-first) but visually and behaviourally improvised. Concretely:

- The loading/empty/error triad is copy-pasted across 7 screens; `.empty` /
  `.hint` / `.done` styles are re-declared in 8 / 5 / 2 SCSS files with
  drifting values.
- Three add paradigms (inline form, card form, none), two edit paradigms
  (inline reuse vs bottom sheet), four delete affordances, and Undo exists
  only on To-do — everywhere else deletion is instant and recovery means
  finding the Trash screen.
- Error handling splits between snackbars and inline retry buttons.
- Shell chrome (top bar, nav, sign-in) is hand-rolled; To-do status pills and
  the menu badge duplicate `mat-chip`/`matBadge`.
- The landing experience is a redirect into a raw two-list CRUD screen.
- No `shared/` directory — reusable pieces float loose in `src/app/`.

The fix is **one interaction grammar** applied everywhere, not screen-by-screen
tinkering.

### 3.2 Foundation: `shared/`

Create `frontend/src/app/shared/` and move the existing floaters (`add-fab`,
`alerts`, `expiry`, `image-picker`, `product-thumb`) plus two new pieces:

- **`<app-list-state>`** — the loading/empty/error triad as one component:
  progress bar while loading; on error an icon + message + Retry button; when
  empty an icon + hint (optionally with a call-to-action); otherwise projects
  the list. Kills the 7 copies and both error styles at once. (Already in
  `../TODO.md` backlog; this is where it lands.)
- **`Feedback` service** — the snackbar grammar:
  `error(msg)` (consistent copy + duration) and
  `undo(msg, { onUndo, onCommit })` (6 s, commits on dismiss — the To-do
  pattern generalised). All screens use it; no raw `MatSnackBar` in features.

Shared SCSS: one `_tokens.scss` for the recurring bits (`.hint`, `.done`,
chip tints) imported instead of re-declared.

### 3.3 One interaction grammar

| Action | Standard | Notes |
|---|---|---|
| Add | FAB → **bottom sheet** with the form | Thumb-reachable, roomy, one pattern. Replaces all inline/card top-forms. The form is a standalone component… |
| Edit | Same bottom sheet, pre-filled | …so add and edit are literally the same UI. To-do detail already proves the pattern. |
| Delete | Trailing icon (lists) / sheet action (detail) → **always Undo snackbar** | `revive()`/trash-restore already exist on every store; wire them uniformly. No instant unrecoverable-in-place deletes. |
| Errors | `Feedback.error` snackbar; **load** failures render in `<app-list-state>` with Retry | Two channels, each with one job. |
| Status markers | `mat-chip` styling via shared classes | Replaces hand-rolled To-do pills, expiry spans, menu badge. |

Form fields: `appearance="outline"` + `subscriptSizing="dynamic"` everywhere
(currently inconsistent).

Migration order for the grammar: Shopping and Inventory first (worst
offenders — Shopping's 6-control flex row, Inventory's two competing add
affordances), then Recipes (the long inline new-recipe card), then sweep.

### 3.4 Shell polish

- Top bar → `mat-toolbar` with the existing content; menu badge → `matBadge`.
- Keep the bespoke bottom-tab/side-rail nav (Angular Material has no M3
  navigation-bar component; the current one already does the M3 active-pill
  correctly) but move its styles onto the shared tokens.
- Sign-in screen: a proper centred `mat-card` — wordmark, one-line tagline,
  the Nextcloud button, quiet build number. First impression currently
  undersells the app.
- Settings: `mat-list` sections (About, Updates, Sync) instead of the bare
  `<dl>`.

### 3.5 Self-hosted fonts and icons

`index.html` loads Roboto + Material Icons from the Google Fonts CDN — on an
offline launch the icon font can be missing, which degrades every screen of an
otherwise offline-capable PWA. Self-host both (npm `@fontsource/roboto` +
`material-icons`, or checked-in woff2) so ngsw caches them with the shell.

### 3.6 The Today screen (new landing)

`''` currently redirects to Inventory — a raw CRUD list. Replace with a
**Today** screen that answers "what needs me?" in one glance:

1. **Wellbeing check-in strip** (§1.2) + today's entries as small faces.
2. **Attention list**: overdue → due today → ready to-dos (capped ~5,
   "all →" link to the To-do tab). Powered entirely by §2's derived states;
   no new backend.
3. **Expiring soon**: the redo of the removed `/expiring` view lands here as
   a card (top 3–5 items by urgency) instead of a standalone page — this is
   the "different approach" `../TODO.md` asks for.
4. **Shortcuts**: Buy (n unticked), House.

All data comes from existing stores/APIs — the screen is composition, not new
plumbing. Inventory stays one tap away as the first tab.

### 3.7 Non-goals

Reminders/notifications, NC `VTODO` mirroring, recurrence, a charting
library, theme toggle (OS-follow stays), multi-user anything.

---

## 4. Increments

Each ships independently, in the usual verify → deploy loop:

| # | Scope | Size |
|---|---|---|
| **A** | Foundation: `shared/`, `<app-list-state>` on all 7 screens, `Feedback` service, tokens SCSS | S–M |
| **B** | To-do timing: migration 0015, backend fields, store v3, waiting/urgency states, sort, chips, datepicker + presets | M |
| **C** | Wellbeing: migration 0014, sync entity end-to-end, check-in strip, history screen (timeline + 14-day SVG), trash/conflict kinds | M |
| **D** | Today landing: check-in + attention + expiring + shortcuts; `''` → today | M |
| **E** | Interaction grammar: add/edit sheets + universal Undo on Shopping, Inventory, Recipes; chip unification on To-do | M–L |
| **F** | Shell: toolbar, sign-in, settings, self-hosted fonts | S |

A before B/C so the new screens are born on the shared components. B before C
only because it's smaller and self-contained; they're independent. D needs B
(attention list) and C (check-in). E and F are independent polish that can
interleave.

Testing per increment follows the existing patterns: Rust `tests/*_db.rs` for
new sync entities/fields, vitest specs for the graph timing states, the merge
fields, `<app-list-state>`, and the Today composition; `npm run e2e` offline
smoke still passing.
