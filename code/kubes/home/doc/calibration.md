# Sensor calibration

The dashboard shows several thermometers that read the same room slightly
differently — a cheap hygrometer's bias is typically a few tenths of a degree.
This describes how we make them agree, and the decisions behind it.

## What we do

Each device has a small **additive correction**, applied in the **browser** so it
can be toggled on and off — the API and the database are always raw:

- `src/calibration.ts` holds the per-device offset map and `offsetFor()`.
- `/api/devices` serves each device's offset as metadata (alongside its label);
  readings everywhere stay raw.
- The frontend applies the offset to the tiles, hero, and temperature/humidity
  charts, gated on a **Calibrated** toggle (on by default, remembered per
  browser). Flipping it is instant — no refetch — since the browser already has
  both the raw value and the offset.
- The `measurement` table stays **raw**, so re-calibrating is a one-line edit in
  `calibration.ts` with no migration and nothing lost.

The offset is static per-device metadata — like the device label and model
(`src/labels.ts`) — so it's served per device, not baked into the time-series.

## How the offsets were derived

By the pipeline in `xinutec-infra/mac-mini/sensor-calibrate.py`, run while all
five sensors sat co-located. Its non-obvious parts are *which points it keeps*
and *letting the data choose the model*, not the fit itself:

1. **Resample** every sensor onto one 5-min grid (the IQAir's clock, nearest
   within ±2.5 min) — the devices never share an exact timestamp.
2. **Co-located vs moved-around:** classify by the *Govee mutual spread* using an
   Otsu split of its bimodal histogram, with a change-point marking the settle
   moment. No hand-picked degrees threshold — it's read off the data's shape.
3. **Steady vs transient:** keep points whose consensus slope is within a few ×
   its own robust noise, so thermal lag during fast changes can't masquerade as
   a calibration offset. Noise-relative, not a fixed °C/h.
4. **Fit** a latent-consensus model: regress each sensor onto the leave-one-out
   consensus of the others.
5. **Choose the order** — offset / linear / quadratic — by **time-blocked**
   cross-validation (random k-fold leaks across autocorrelated neighbours and
   flatters complex models). The simplest model within one CV standard error of
   the best wins.

**Result:** a single additive **offset per device** is all the data supports.
Linear and quadratic terms were *worse* on held-out time — they overfit the
narrow indoor range each derivation samples. A gain or curve could only be
justified by data spanning a much wider (seasonal) temperature range; because
storage is raw, re-running the script then will upgrade the model order on its
own if the evidence appears.

## The reference choice

"Make them agree" requires an anchor — what absolute temperature they agree on.
The relative offsets between devices are fixed by the data; the anchor only
shifts everyone by a constant. We anchor to the **duplicate-collapsed type
consensus**: each sensor *type* (IQAir, Govee H5075, Govee H5103) gets one vote.

This matters because three of the Govee are the **same model (H5075)** and so
share a systematic bias — averaging them reduces random noise but not that shared
bias. In a naive 5-way median they cast three correlated votes and drag the
consensus ~0.2 °C toward themselves purely by headcount. Collapsing each type to
one vote removes that. (Anchoring to the IQAir alone, or collapsing further to
brand — IQAir vs Govee, one vote each — were the alternatives considered.)

There is no ground-truth thermometer, so the anchor is a deliberate choice, not a
measured truth.

## Re-calibrating

1. Re-run `xinutec-infra/mac-mini/sensor-calibrate.py` (sensors co-located). It
   derives from the **past 24 h** by default; `--hours N` or `--from/--to` widen
   the window (a longer window gives more steady points and a firmer fit).
2. Copy the chosen anchor's offsets into `OFFSETS` in `src/calibration.ts`.
3. Deploy. Offsets travel with the sensor, so they stay valid after a unit is
   moved to its room.

Humidity uses the same pipeline (`--field humidity`) but is not yet corrected.
