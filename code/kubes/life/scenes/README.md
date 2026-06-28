# scenes — house geometry

Hand-authored parametric models of the real rooms in the house, measured by
hand. The 3D house view will render from these (richer than the simple
`{x,z,w,d}` boxes the location tree's `position` field currently uses).

`house.json` holds the model. It's the living room only for now (the first
room, hand-measured); we extend it into the complete house from here.

## Format

```jsonc
{
  "height": 2.4,                    // room height, metres
  "walls": [[turn_deg, length_m], ...],  // perimeter walk (see below)
  "furniture": [ { cx, cz, w, d, h, y0?, color? }, ... ],
  "highlight": null,                // wall index to flag, or null
  "question": "..."                 // optional design note (free text)
}
```

- **Coordinates:** X = right, Z = away, Y = up; metres.
- **walls** — a perimeter *walk*: each wall is `[turn_deg, length_m]`, where
  `turn_deg` is the heading change at the corner *before* the wall (0 =
  straight, positive = left, negative = right), starting along +X. Angled
  segments (e.g. 37°/53°) describe a bay window.
- **furniture** — floor boxes centred at `(cx, cz)`, size `w`×`d`×`h`; `y0` is
  the base height off the floor (>0 = elevated, e.g. a soffit/beam); `color` is
  a hex string.

## TODO toward a complete house

- Drop the `question` field (a leftover from the tool this came from).
- Add the other rooms; decide how rooms compose into one house model (shared
  origin / offsets) and how this relates to the DB location tree + items.
