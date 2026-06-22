# Robust-evidence decoder — let the joint model own noise vs signal

Status: accepted, in implementation (2026-06-22). Completes #257 (decoder to
authority) and supersedes the upstream hard GPS-outlier drop.

## The anti-pattern this removes

A hard, lossy filter — `dropGpsOutliers` — runs *upstream* of the probabilistic
decoder and makes an irreversible decision the decoder should make. It looks at a
fix with no context and deletes it. But whether an 850 m jump is **noise** or a
**tube reacquisition** is not knowable in isolation — it depends on whether its
endpoints are two stations on a shared line. Only the decoder, which has the
mode/line hypotheses, can interpret it. Deleting first destroys the evidence
before the one component that could use it runs.

Measured cost (2026-06-22, Euston Square→St Pancras one-stop Tube hop): the
reacquisition jump that proves the ride is stripped as an outlier, so the decoder
sees a pure GPS gap whose net displacement over the surrounding walk is
walking-paced → decodes `walking`, and the train candidate is never even
enumerated. The model isn't choosing car over tube; it never sees the tube.

This is the same principle the rest of the 2026-06 work converged on — **weight
evidence, don't hard-filter it** (robust GPS in the pedestrian smoother; speed as
a likelihood in the bus matcher; "probabilities, not veto code"). The decoder is
the last place still violating it, on its most important input.

## The architecture

Carry every fix into the decoder with its uncertainty, and let the joint model
explain it. A genuinely bad fix *self-attenuates* under a robust emission; a
context-meaningful jump is explained by the hypothesis that fits it.

1. **Per-fix accuracy is first-class.** The GPS the decoder observes carries its
   reported accuracy (heteroscedastic noise), not a binary present/deleted.
2. **The GPS emission is robust** — heavy-tailed and accuracy-weighted (the Huber
   idea the pedestrian smoother already uses). A garbage fix gets low likelihood
   under *every* mode and contributes ≈nothing; no deletion needed.
3. **`dropGpsOutliers` is retired** (demoted to a soft confidence input at most) —
   its job now happens inside the model, where context exists.
4. **The candidate generator sees the full track**, so a reacquisition jump
   surfaces the station-to-station hop; the decoder weighs walking (can't explain
   an 850 m/min jump → crushed) vs `train@line` (explains it + station pair) and
   picks Tube. The entry-prior + Viterbi + `movement→train` override (all already
   built) do the combining — speed, station-pair, gap, no-dwell — natively.

One probabilistic model, fed all the evidence, owns "what happened" end to end.
Eliminates the *class* of "decoder blind because something upstream deleted the
proof" bugs, not just this hop.

## Staged, measured plan

Corpus-wide (every day re-decodes), so phased with a golden gate at each step;
re-bless only against the ground-truth **narratives**, never pipeline output.

- **Phase 1 — accuracy plumbing (golden-safe, no behaviour change).** Carry
  per-fix `accuracy` through the Kalman (`FilteredPoint`) into the observation
  tensor (`Observation.gps.accuracyM`). Nothing reads it yet → decode output
  unchanged → golden unchanged. Just makes the signal available.
- **Phase 2 — robust accuracy-weighted GPS emission.** Replace the plain speed
  Gaussian / implicit hard presence with a heavy-tailed, accuracy-weighted GPS
  likelihood. Calibrate so the decoder still matches golden ground-truth
  day-by-day; this is the careful one.
- **Phase 3 — retire `dropGpsOutliers`.** Feed the full fix stream to the decoder;
  the robust emission absorbs the garbage. Re-bless the corpus against narratives.
- **Phase 4 — confirm the hop.** The candidate generator now sees the
  reacquisition jump; verify Euston Square→St Pancras (and its class) decodes
  `train@line` end to end, and the timeline reads Tube.

## Relationship

- `#257` decoder-to-authority — this is its completion (the decoder owns mode via
  full-evidence robust inference, not a downstream override of a starved decode).
- `2026-06-pedestrian-trajectory-smoother` / `2026-06-map-constrained-positioning`
  — same robust-evidence principle; this brings it to the decoder's GPS emission.
- Retires the hard `dropGpsOutliers` stage and the late `vehicleSplit`→bus/drive
  misclassification path for embedded tube hops.
