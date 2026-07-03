# scenes — house geometry

Hand-authored parametric models of the real rooms in the house, measured by
hand. The 3D house view (`frontend/.../features/house`) renders from these.

`house.json` holds the model: a set of **rooms**, each its own outline.

## Format

```jsonc
{
  "height": 2.4,                          // wall height, metres
  "rooms": [
    {
      "name": "living",                   // optional label
      "start": [0, 0],                    // world XZ of the first corner
      "heading": 0,                       // initial heading, degrees (default 0)
      "walls": [[turn_deg, length_m], ...],   // outline walk (see below)
      "openings": [                       // doorways / windows in this room's walls
        { "wall": 11, "offset": 1.37, "width": 1.5, "height": 1.94,
          "sill": 0, "depth": 0.15, "leads": "dining" }
      ]
    }
    // ... more rooms ...
  ],
  "furniture": [ { cx, cz, w, d, h, y0?, color? }, ... ],
  "highlight": null,                      // reserved
  "question": "..."                       // optional design note (free text)
}
```

- **Coordinates:** X, Z on the floor plane, Y up; metres. A wall walk steps by
  `X += len·cos(heading)`, `Z += len·sin(heading)`.
- **rooms / walls** — each room is a closed outline walked turtle-style from
  `start` at `heading` degrees: each wall is `[turn_deg, length_m]` — add
  `turn_deg` to the heading, then step `length_m`. The last wall should return to
  `start`. (The first room was hand-measured; later rooms are traced live in the
  dev preview.)
- **openings** — a doorway/window cut into one wall: `wall` is the index into
  that room's `walls`; `offset` is metres from the wall's start to the near edge;
  `width`×`height` size the hole; `sill` lifts the bottom off the floor (0 = a
  doorway). A full-width floor-to-`height` opening leaves just a header.
  `depth`/`leads` are informational.
- **shared walls** — adjacent rooms each include the shared wall in their own
  outline (it's simply drawn by both), and a connecting doorway is an opening in
  each room's copy. There are no special "partition" or "between-rooms" objects —
  every room is the same kind of thing.
- **furniture** — floor boxes centred at `(cx, cz)` (world coords), size
  `w`×`d`×`h`; `y0` = base height off the floor (>0 = elevated); `color` hex.

## Dev aids

The renderer numbers each wall (global index across rooms, dev build only) so you
can refer to "wall 14". `?red=14,5` on the `/house` URL tints those walls red.

## Live modelling workflow

The house is built up collaboratively, one measured piece at a time, against a
live local preview:

- `node scripts/house-preview.mjs` serves the dev frontend + this scene on
  `http://localhost:4280` (LAN-reachable, so you can watch it on a phone). It
  re-reads `house.json` on **every request**, so editing the scene + reloading
  shows the change instantly — no DB, no backend, no auth. Build the dev
  frontend once first: `cd frontend && npm run build`.
- **Red = a guess.** Give an estimated furniture box `"color": "#ff5252"`, then
  swap it to its real colour once the measurement lands. `?red=14,5` tints those
  *walls* red the same way (see Dev aids). Furniture honours its own colour;
  walls use the query param.
- **A shared-wall opening must be cut into BOTH rooms' copies.** A door or hatch
  between (say) kitchen and dining is an opening in the kitchen's wall *and* in
  the dining room's wall — they're separate outlines drawn ~15 cm apart. Cut
  only one side and you look through the near hole onto the still-solid far wall,
  so the opening reads as opaque/floor-to-ceiling. (This is why doors already
  work: they're listed in each room's `openings`.)
- **Left/right is mirror-prone.** The default camera frames the house from one
  side, so a wall viewed from behind swaps left↔right. Measure and place by
  distance from a landmark (a corner, the hob, a doorway), not "on the left".
