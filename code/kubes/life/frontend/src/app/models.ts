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
export type { SearchHit } from './generated/SearchHit';
export type { ShoppingItem } from './generated/ShoppingItem';
export type { RecipeIngredient } from './generated/RecipeIngredient';
export type { Recipe } from './generated/Recipe';

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

/** Hand-authored house geometry (scenes/house.json). Walls are a perimeter
 *  walk: each [turn_deg, length_m]. See scenes/README.md. */
export interface HouseScene {
  height: number;
  walls: [number, number][];
  furniture: Furniture[];
  highlight: number | null;
  question?: string;
}
