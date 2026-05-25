# Probabilistic system: ground rules and principles

This document captures the architectural philosophy of the
classification system — the *why* behind decisions that the
proposal docs and commit messages individually describe but never
collect in one place.

Read this before adding new factors, tuning parameters, or
proposing alternatives. The technical specifics of any one
component live in its own proposal under `docs/proposals/`; this
file is the contract on which all of those proposals operate.

## The frame: probabilistic physical constraint solver

We are building a *probabilistic constraint solver*, not a stack
of heuristics. The system encodes everything we know about how
the user's day physically works — including biological,
geometric, and social regularities — as soft probabilistic
factors that compose multiplicatively (additively in log-space)
into a joint posterior over state sequences.

The classification pipeline isn't a sequence of `if/else`
discrimination rules layered on top of a Markov chain. It is a
factor graph in which:

- The hidden state at each minute is a `(mode, place, line)`
  tuple drawn from the user's known places and rail lines.
- Each piece of evidence (a GPS fix, an HR reading, a Fitbit
  sleep stage, a Kalman-smoothed speed, a duration) contributes
  a calibrated log-probability factor.
- Inference (Viterbi for MAP, forward-backward for posterior
  marginals) finds the state sequence that jointly maximises
  those factors.

When the data is unambiguous, the posterior concentrates on one
answer. When the data is genuinely ambiguous (sparse GPS, sensor
gaps, overnight indoor noise), the posterior spreads — and the
user-facing presentation must reflect that.

## Rule 1: there are no hard constraints

Every constraint is a probability, even ones that "feel
impossible." A 1-minute teleport between London and Karlsruhe is
not literally probability zero — it is probability ~10⁻⁴⁵ from a
mis-timestamped fix, a buffered stale GPS coordinate, or an
adversarial input we haven't anticipated. Modelling it as
`-Infinity` collapses a graduated belief into a binary veto, and
loses information at exactly the moments we need to weigh
evidence rather than dictate it.

In practice this means:

- **Don't write `return -Infinity` for impossibilities.** Use a
  very-low-finite log-prob (e.g. `-10` to `-15` nats) that
  encodes "essentially impossible but recoverable if every
  other factor screams the opposite."
- **The `-Infinity` exceptions** are reserved for mathematical
  identities (`log(0)`, division by zero, invalid arguments) —
  not probabilistic statements.
- **Hard-zero transitions** (`stationary @ A → stationary @ B`
  no-teleport; `train @ L → stationary @ P` station-graph) are
  *currently* implemented as `-Infinity` for computational
  shortcut, but the framework permits softening them to finite
  high-penalty factors at any time. Their MAP outcome doesn't
  change.

The deeper reason: forcing absolute certainty is exactly the
heuristic-patching pattern this system was built to escape. If a
new constraint feels like it needs a hard veto, that's the
signal to model it more carefully, not to add one.

## Rule 2: probabilities are graduated and conditional

A single soft factor isn't enough — the framework requires that
factors compose to express graduated, jointly-conditional
beliefs. Pippijn's concrete example:

| Scenario                       | Plausibility | Why                          |
|--------------------------------|--------------|------------------------------|
| Walking for 8h while asleep    | ~0           | Sleepwalking is brief        |
| Driving for 8h while asleep    | ~0           | Would crash                  |
| On a plane for 8h while asleep | Plausible    | Long-haul flight             |
| On a train for 8h while asleep | Unlikely     | Sleeper trains exist, rare   |
| On a train for 30m while asleep| Plausible    | Power nap on the commute     |

This composes naturally from a per-minute `P(observed sleep_stage | mode)`
emission factor that varies per mode, combined with the
duration factor `P(d | mode)` and the joint MAP path. No special-
case logic, no flags, no thresholds. The probabilities multiply.

In code: every factor function returns `log P(observation | hidden_state)`
in the relevant condition (per-minute emission, per-segment
duration, per-transition entry boost). The Viterbi / forward-
backward inference does the rest.

## Rule 3: runtime budget is generous, but read-side is hard

> *"By 'quickly' I mean runtime: the user loads the page and
> wants to see 'your day'. It doesn't need to all happen live
> (we can do any amount of offline precomputes we need), but the
> user shouldn't wait minutes."*

The architectural consequence:

- **Heavy inference runs offline.** A cron job re-decodes
  recent days using the most expensive model we want; results
  land in the `decoded_days` cache table.
- **The page-load path is a single `SELECT decoded_days`.**
  Milliseconds of latency. No live decode, no live OSM fetch,
  no live HMM run.
- **Model complexity is bounded by the offline budget**, not the
  request budget. ~3–10 seconds per day of HSMM decoding is fine.
  60 seconds per day would be fine if the model improved enough
  to justify it.
- **Recompute over an N-day window**, never incremental
  accumulation. When parameters change (model retrains, place
  centroids drift, sleep tags update), we re-decode the whole
  recent window. Reproducibility > incremental cleverness.

## Rule 4: do it right, not MVP-shortcut

We are past MVP. The real architecture is in place; bolting on
"good-enough-for-now" code at this stage builds debt that the
framework will then have to work around forever.

Specific implications:

- **A new physical constraint** becomes a new soft factor in
  the existing emission / transition / duration interfaces. Not
  a special-case branch, not a flag, not a wrapper. If the
  framework doesn't accept the factor, extend the framework.
- **A new signal** (battery level, day-of-week pattern, HR
  intraday derivative) is plumbed into the `Observation`
  shape, weighted by a calibrated `P(signal | state)` factor,
  and added to the per-minute emission. It does not become a
  post-processing pass.
- **A new mode** (e-bike, scooter, plane) gets its own state in
  the state space, its own duration distribution, its own
  emission distribution. Not a sub-flag on an existing mode.
- **Calibration comes from data**, not from intuition. When in
  doubt, fit from heuristic-labeled minutes (or human-confirmed
  ground truth where it exists). Hand-tuned parameters are a
  bootstrap stage; every one is technical debt to be retired.

## Rule 5: expose uncertainty, never hide it

The MAP path was always a compromise — a single best guess that
collapses the model's actual posterior. The architectural
endpoint is the posterior over states per minute, exposed as
first-class output.

When the system is confident (overnight at Home: 99% one place),
the user sees a single definite answer. When the system is
genuinely uncertain (indoor cafe with three candidates within
50m, all consistent with the GPS noise model), the user sees the
top alternatives with their confidence percentages.

The output schema is therefore not `state[]` per minute, but
`distribution[]` per minute. The frontend renders the top-1
when confidence is high and surfaces top-3 when confidence is
mixed.

This rule has a corollary: **do not "improve" the system by
artificially sharpening the posterior.** Tighter Gaussians,
narrower priors, more aggressive vetos all *look* better in the
mode-only audit metric while hiding the model's actual
uncertainty. The metric to optimise is *calibration* (the
posterior matches the long-run frequency of being right), not
top-1 agreement.

## The current factor library

These are the factors that exist as of the writing of this
document. Each is a soft probabilistic contribution; none is a
hard constraint (except the `-Infinity` shortcuts noted above
that are mathematically equivalent to very-low-penalty soft
factors at the MAP scale).

| Layer        | Factor                       | Source                              | Status   |
|--------------|------------------------------|-------------------------------------|----------|
| Initial      | Visit-frequency prior        | `focus_places.total_dwell_sec`      | Wired    |
| Emission     | Per-mode HR Gaussian         | Learned from heuristic labels        | Wired    |
| Emission     | Per-mode cadence (zero-inflated) | Learned from heuristic labels    | Wired    |
| Emission     | Per-mode speed Gaussian      | Learned from heuristic labels        | Wired    |
| Emission     | Per-mode GPS-presence Bernoulli | Hand-tuned uniform 0.85           | Wired    |
| Emission     | Per-place HR override        | Learned from heuristic labels        | Wired    |
| Emission     | Sleep state (`inBed`)        | Fitbit `sleep_stages`               | Wired    |
| Emission     | Asleep-HR override           | Universal asleep distribution        | Wired    |
| Emission     | Place-distance (heavy-tailed) | Gaussian capped at -3 nats          | Wired    |
| Emission     | Off-network log-prior        | Calibrated against place-distance    | Wired    |
| Transition   | Self-loop (HSMM duration-aware) | log(0.95) cross-mass split        | Wired    |
| Transition   | Station-graph (train ↔ place) | OSM stations within 400m of place  | Wired    |
| Transition   | Hour-of-day entry boost      | `focus_places.hour_profile`         | Wired    |
| Segment      | Per-mode duration Gamma      | Hand-tuned from empirical histograms | Wired    |
| Pre-process  | GPS outlier filter           | Cluster-median 2km deviation        | Wired    |
| Pre-process  | GPS QC (anchor walk)         | Velocity pipeline `qualityFilterGps`| Wired    |

Inference modes:

- **Viterbi MAP** (HSMM) — single best state sequence; cached to
  `decoded_days`.
- **Forward-backward posterior marginals** (HSMM) — per-minute
  distribution over states; exposes confidence for user-facing
  presentation.

## Factors that are missing (the to-add list)

These compose into the same framework — each is a new factor
function returning a log-probability, plumbed into the existing
emission / transition / segment interfaces. None requires a
framework rewrite.

- **Geometric feasibility on segment transitions**: when closing
  a movement segment between two stationary places, the
  segment's duration must be consistent with `distance(A, B) /
  max_speed(movement_mode)`. Currently absent — manifests as
  the overnight place-bouncing pathology.
- **HR continuity**: pair-wise factor on `|HR_t - HR_{t-1}|`.
  HR doesn't jump 50 bpm in one minute without a mode change.
- **Battery level**: low + decreasing implies the user isn't
  active; high + stable implies charging (often overnight at a
  known place).
- **Day-of-week patterns**: weekday vs weekend changes the
  prior over which places are visited at what hours.
- **Per-place duration distributions**: stationary @ Home is
  bimodal (short drop-ins + overnight stays); the per-mode
  Gamma can't fit both.
- **Per-amenity-class HR priors**: hospitals / clinics share a
  learned elevated-HR baseline; one-off visits to a new clinic
  inherit it.
- **Hierarchical / empirical-Bayes priors**: per-place fits
  draw from a hyper-prior so rare-data places aren't
  unconstrained. Already partly implemented (hyper-prior for
  unfitted places); needs the full hierarchical model.

## Audit and verification

Two complementary tools:

- **Mode-level agreement metric**: `compare-hmm-vs-heuristic`
  reports per-minute agreement between heuristic and HSMM. Good
  for catching mode-misclassification regressions. Blind to
  place attribution.
- **Side-by-side render (`--render`)**: per-minute timeline
  showing heuristic label and HSMM label side by side. Reveals
  place-level errors that the mode metric hides.
- **Posterior marginals (`--marginals`)**: per-hour top-3 states
  with their probability mass. Reveals the model's actual
  uncertainty.

Always render before declaring a change "an improvement." The
mode metric alone has misled this work multiple times.

## What this means in practice for new contributions

If you find yourself:

- Writing a `-Infinity` for a "real-world impossible" case →
  use a calibrated low log-prob instead. See Rule 1.
- Adding a flag / threshold / cutoff to control behaviour →
  model whatever the flag is selecting between as two factors
  with different log-probs.
- Pushing through a tuning value that makes one day's audit
  number jump → re-render and check it didn't regress others;
  also check that the same change is justifiable from the data,
  not the day.
- Tempted to hard-lock a state when a strong signal fires
  ("definitely asleep, must be stationary") → factor it as a
  per-minute soft factor with a strong log-ratio; let the
  composition speak.
- Adding a fast path / heuristic for "the common case" → don't.
  The factor system is supposed to BE the common case. Anything
  fast-path is admitting the framework is wrong somewhere.

These aren't style preferences — they're the difference between
a probabilistic system and a stack of patches with a Bayesian
veneer.
