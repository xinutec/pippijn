// Wire types shared with the Rust backend.
//
// The API DTOs are GENERATED from the Rust types by ts-rs (scripts/gen-types.sh
// → ./generated/) so they can't drift — do not hand-edit ./generated. A drift
// gate (scripts/check-types.sh, in the pre-push hook) fails if the Rust types
// change without regenerating.
export type { ConnectionStatus } from './generated/ConnectionStatus';
export type { Me } from './generated/Me';
export type { LocationKind } from './generated/LocationKind';
export type { Loc } from './generated/Loc';
export type { ItemCategory } from './generated/ItemCategory';
export type { Item } from './generated/Item';
export type { Product } from './generated/Product';
export type { ShoppingItem } from './generated/ShoppingItem';
export type { RecipeIngredient } from './generated/RecipeIngredient';
export type { Recipe } from './generated/Recipe';
export type { Todo } from './generated/Todo';
export type { TodoType } from './generated/TodoType';
export type { TodoStatus } from './generated/TodoStatus';
export type { TodoPriority } from './generated/TodoPriority';
export type { TodoLink } from './generated/TodoLink';
export type { LinkKind } from './generated/LinkKind';
export type { TargetKind } from './generated/TargetKind';
export type { ConflictEntry } from './generated/ConflictEntry';
export type { ConflictKind } from './generated/ConflictKind';
export type { TrashEntry } from './generated/TrashEntry';
export type { TrashKind } from './generated/TrashKind';

// Scene-file types are frontend-owned: /api/house streams scenes/house.json
// through as raw JSON (no Rust struct), so these aren't generated.

/** A furniture floor-box in the house scene. Centred at (cx,cz); w×d×h metres;
 *  y0 = base height off the floor. */
export interface Furniture {
  cx: number;
  cz: number;
  w: number;
  d: number;
  h: number;
  y0?: number;
  color?: string | null;
}

/** An opening (doorway / window / wide cased passage) cut into one of a room's
 *  walls (`wall` = index into that room's `walls`), leaving a lintel above (and a
 *  sill below, for windows). `offset` is metres from the wall's start to the near
 *  edge; `width`×`height` size the hole; `sill` lifts the bottom off the floor
 *  (0/omitted = floor-level). A doorway between two rooms is just an opening in
 *  each room's copy of the shared wall. `depth`/`leads` are informational. */
export interface WallOpening {
  wall: number;
  offset: number;
  width: number;
  height: number;
  sill?: number;
  depth?: number;
  leads?: string;
}

/** One room: its own closed outline, walked turtle-style from `start` (world XZ
 *  of the first corner) at `heading` degrees — each wall is [turn_deg, length_m].
 *  Rooms that adjoin simply repeat the shared wall in each of their outlines. */
export interface Room {
  name?: string;
  start: [number, number];
  heading?: number;
  walls: [number, number][];
  openings?: WallOpening[];
}

/** Hand-authored house geometry (scenes/house.json): a set of rooms (each its own
 *  outline) plus furniture. See scenes/README.md. */
export interface HouseScene {
  height: number;
  rooms: Room[];
  furniture: Furniture[];
  highlight?: number | null;
  question?: string;
}
