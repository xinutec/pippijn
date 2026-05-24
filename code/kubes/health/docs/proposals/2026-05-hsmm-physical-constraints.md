# Hidden Semi-Markov Model: physical-constraint modelling

Date: 2026-05-24

## Why now

The current per-minute Markov HMM can't encode minimum-duration
constraints because they violate the Markov property
(`state_t` would depend on the run-length-so-far, not just on
`state_{t-1}`). That gap is the dominant remaining failure mode:

- Overnight, the HMM bounces through 7+ random near-Home focus
  places, bridging via 1-minute `plane → driving → train →
  walking` segments. The Markov self-loop bias is +0.05 nats per
  minute of staying — small enough that other places win out
  when their place-distance term is fractionally better at some
  GPS fix.
- A real plane segment is ≥ 30 minutes (taxi + flight). A real
  train ride is ≥ 2 minutes. A real driving stretch is ≥ 1
  minute. A real stationary stay is ≥ ~3 minutes (otherwise
  it's a stop at a traffic light, not a "place visit"). The
  Markov framework has no way to say this.

Per pippijn's framing: we're aiming for a *probabilistic physical
constraint system*. Two structural hard-zeros + per-minute
Gaussian emissions + self-loop bias is a very thin factor library.
The real architecture is a factor graph where each constraint —
hard or soft — is an explicit factor, and inference finds the
MAP assignment respecting all of them.

## Approach

A **Hidden Semi-Markov Model (HSMM)** is the minimum
architectural step that buys us minimum-duration modelling
without abandoning the existing Viterbi-style inference. It
extends the state to include duration-so-far implicitly: rather
than choosing a state per minute, the HMM chooses a (state,
duration) tuple where the duration is the planned run length of
this segment.

Two equivalent formulations:

### Formulation A — Explicit-duration HSMM

State at time t: `(s, d)` where `d` is "minutes remaining in this
state". Transitions:

- `(s, d) → (s, d-1)` with prob 1 — count down the duration.
- `(s, 1) → (s', d')` with prob `T(s, s') · P_d(d' | s')` —
  when the duration runs out, transition to a new state with
  duration drawn from `P_d(. | s')`.

Inference: Viterbi over the augmented state space. State space
balloons by ~`max_duration`, but max_duration is bounded (~120
minutes for a long stay), so still tractable.

### Formulation B — Segment-based HSMM

Decode as a sequence of `(start_min, end_min, state)` segments
instead of per-minute labels. Each segment has a duration
likelihood. Inference: a dynamic-programming algorithm over
segment boundaries (not minute boundaries). Cubic in T (number
of minutes) in the naive form, but tractable for T ≈ 1440 if
we bound max segment duration.

For our scale (T = 1440 minutes, ~150 states, max_duration ≈ 120):

- A: 1440 × 150 × 120 = 26M state transitions per day. ~5s decode.
- B: 1440² × 150 = 311M boundary evaluations naive. With
  max_duration bound, 1440 × 120 × 150 = 26M. Same order.

Either is fine for the offline cron budget. **Pick A** —
keeps the inference loop structurally similar to current Viterbi
(per-minute), just with an augmented state.

## Duration distributions

Per-state duration distribution `P_d(d | s)`. Modeled as
gamma-like (right-skewed positive) with parameters from data:

- `stationary`: heavy-tailed. Most stays 5-60 min, but Home
  overnight is 480-540 min. Long tail. Mean ~30 min.
- `walking`: 5-30 min typically. Cap at 60.
- `cycling`: 10-120 min.
- `driving`: 5-180 min.
- `train`: 3-120 min.
- `plane`: 30-720 min (short hop to transcontinental).
- `unknown`: short — represents gaps in observation, not a real
  state. 1-15 min.

Fit from heuristic labels via supervised MLE on segment durations.

Hard floors (encoding physical impossibility) as overrides on
the fitted density:

- `plane`: `P_d(d < 5) = ε` (planes don't fly 5 minutes). The
  Markov band-aid (`plane GPS-null penalty = -8 nats`) collapses
  into one consequence of this.
- `train`: `P_d(d < 1) = ε` (no 1-minute train rides — that's
  station-to-station distance physics).
- `stationary @ knownPlace`: `P_d(d < 2) = ε` (1-minute stops
  at known places are heuristic noise — drive-by GPS fixes near
  a known place don't count as a visit).

ε is small (e.g. `log(0.001) = -6.9`) — soft hard-zero. Not
literal -Infinity in case real data does violate.

## Physical constraint factors to add

Beyond min-duration, the HSMM framework opens space for other
physical constraints as factors:

1. **HR continuity**: per-pair-of-adjacent-minutes constraint on
   `|HR_t - HR_{t-1}|`. HR can swing 20-30 bpm rapidly during
   exercise transitions but rarely 50+ in 1 minute at rest. A
   transition `stationary @ Home → walking` with HR jumping from
   65 to 130 is implausible (warm-up is gradual).

2. **Distance consistency** across non-adjacent stationary
   segments: if `stationary @ A` ends at minute t and
   `stationary @ B` starts at minute t', then the implied speed
   `dist(A, B) / (t' - t)` must be consistent with the mode of
   the segments in between. If no segment in between covers the
   distance, the stationary attributions are wrong.

3. **Sleep-state coherence**: when `sleep_stages` says
   asleep/in-bed, mode MUST be `stationary` (hard transition
   factor). Currently the heuristic uses this and the HMM
   doesn't.

4. **Mode-pair feasibility**: e.g. `cycling → train` requires a
   `stationary` (locking up the bike) or `walking` (carrying it)
   in between. Same for `train → cycling`. Hard-zero direct
   `cycling → train` transitions.

5. **Time-of-day priors** on mode-likelihood: planes more likely
   06:00–22:00, trains weekday-peak 07-09/17-19, etc. Per
   pippijn's pattern, but currently unused.

Each of these is a factor with a clear physical interpretation.
They compose multiplicatively (additively in log-space) in the
joint MAP score.

## What this proposal IS, and IS NOT

IS:
- Add explicit-duration HSMM as the inference framework
  (replaces per-minute Viterbi).
- Add per-state duration distributions, fit from data with
  hard-floor overrides for physically impossible short
  durations.
- Add HR-continuity factor as a pair-wise constraint.
- Add sleep-state hard transition factor (Fitbit asleep ⇒
  stationary).

IS NOT:
- A full factor graph with belief propagation. HSMM is the
  smallest extension to Markov that buys minimum-duration.
  General factor graph with multi-step cliques is a bigger
  step; defer until we see what HSMM doesn't cover.
- A neural seq model. Same reasoning: HSMM closes the visible
  gap; only consider replacement if it doesn't.
- An EM training loop. Initial duration distributions are fit
  via supervised MLE on heuristic-labeled segments. EM
  iteration to re-fit on smoothed labels is a separate phase.
- Wired into prod. Audit CLI is still the only consumer.

## Implementation plan

1. **Duration data collection**: per-mode segment durations
   from existing heuristic-labeled days. CLI:
   `dump-segment-durations`. Pure analysis tool, no schema
   change.

2. **Duration distribution module**:
   `src/hmm/duration-dist.ts`. Pure functions for fitting and
   evaluating per-state duration log-prob. Gamma family, with
   hard-floor for physically-impossible short durations.

3. **HSMM inference**:
   `src/hmm/hsmm-viterbi.ts`. Replaces `viterbi.ts` semantics
   with explicit-duration augmented state. Same input shape
   (states, observations, transition, emission, initial) plus
   duration. Output: same per-minute state sequence (the
   `(state, duration)` is internal).

4. **Wire into audit CLI**: extend `compare-hmm-vs-heuristic` to
   optionally use HSMM. Flag: `--hsmm`. Both decoders available
   side-by-side for direct comparison.

5. **Sleep coherence factor**:
   `src/hmm/sleep-coherence.ts`. Loads `sleep_stages` for the
   user, builds a per-minute hard constraint "must be
   stationary when asleep". Wired via the existing transition /
   emission interfaces.

6. **HR-continuity factor**: not a Markov constraint, but
   per-(prev-minute, curr-minute) constraint. Naturally fits as
   a transition factor that depends on both states AND on the
   previous observation's HR.

7. **Audit + iterate**: run blessed days HSMM vs Markov, side-by-
   side render, evaluate.

## Expected outcome

HSMM with realistic duration distributions should:

- Eliminate the overnight place-cycling: a 1-minute `stationary`
  detour to a different place costs much more than the
  multiplicative duration penalty `P_d(1 | stationary @ X)`.
- Fix the post-tube Work-leaving-and-returning thrash: 5-minute
  fake train rides inside a 2-hour Work stay get a duration
  penalty proportional to `log(P_d(5 | train))` which is small
  (trains can be 5 min) but the `log(P_d(120 | Work))` for the
  alternate (one long Work stay) wins.
- Not fix the elevated-HR Cleveland case directly — that's an
  emission issue and needs per-place HR (already added) or HR
  continuity. But HSMM + HR continuity together should.

## Cost estimate

- Duration distribution fitting + module: 1-2 sessions.
- HSMM Viterbi: 1-2 sessions. Algorithm is standard; main work
  is keeping the API compatible with the existing wiring.
- Sleep + HR continuity factors: 1 session each.
- Audit iteration: 1-2 sessions.

Total: ~1 week of focused work. The architectural payoff is
substantial — every future physical constraint we want to add
becomes a single new factor, not a system rearchitecture.
