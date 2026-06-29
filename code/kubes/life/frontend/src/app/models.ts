// Shapes returned by the Rust backend. The inventory/recipe types are serde
// derives → snake_case keys; /api/me is hand-built → camelCase.

export type ConnectionStatus = 'active' | 'needs_reauth' | 'not_linked';

export interface Me {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  nextcloud: ConnectionStatus;
}

export type LocationKind = 'house' | 'room' | 'cupboard' | 'fridge' | 'layer';

export interface Loc {
  id: number;
  kind: LocationKind;
  name: string;
  parent_id: number | null;
  sort_order: number;
  position: unknown | null;
}

export type ItemCategory = 'food' | 'medication' | 'tool' | 'document' | 'other';

export interface Item {
  id: number;
  name: string;
  category: ItemCategory;
  quantity: number | null;
  unit: string | null;
  expiry: string | null;
  location_id: number | null;
}

export interface SearchHit {
  item: Item;
  path: Loc[];
}

export interface ShoppingItem {
  id: number;
  name: string;
  quantity: number | null;
  unit: string | null;
  done: boolean;
}

export interface RecipeIngredient {
  name: string;
  quantity: number | null;
  unit: string | null;
}

export interface Recipe {
  id: number;
  name: string;
  instructions: string | null;
  servings: number | null;
  ingredients: RecipeIngredient[];
}

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
