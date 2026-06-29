# Catalog vs holdings

The data model splits *what a thing is* from *what you have*. This is the
catalog-vs-inventory (SKU-vs-stock) split, and it's what makes "fetched or
manually entered, with or without a barcode" all one shape.

## The two core entities

- **Product** (`products`) — the catalog: a definition. "Yeo Valley 950 g
  Natural Yoghurt, barcode 5036589255550." **One row regardless of how many you
  own.** Some rows come from Open Food Facts (keyed by barcode), some you define
  by hand (no barcode). Single-user app → `products` is just Pippijn's catalog;
  no per-user sharing.
- **Item / holding** (`items`) — a concrete thing you possess: "a tub of that,
  in the fridge, expires 5 Jul, qty 1." **Many items → one product.**

An item links to a product via `product_id` (nullable) **or** stands alone with
its own `name`. That nullable link + name fallback is the whole trick:

| Entry | Product row | Item row |
|-------|-------------|----------|
| Barcode (OFF / typed) | looked-up / created by barcode | `product_id` → it |
| Manual, recurring | a barcode-less product you define | `product_id` → it |
| Manual, one-off | none | `product_id` NULL, `name` set |

Display name/brand/image resolve as `COALESCE(product.…, item.…)`.

## Tables and links

```
locations ──<  items        items.location_id → locations.id  (nullable, SET NULL)
locations self-tree         locations.parent_id → locations.id (CASCADE)
products  ──<  items        items.product_id   → products.id   (nullable, SET NULL)
products  ──<  shopping_items   (buy entries; same nullable-product + name pattern)
items     ──<  item_history     (append-only audit)
products  (UNIQUE barcode where present)
```

Indices that matter: `products.barcode` UNIQUE (lookup + dedup); `items
(user_id)`, `items(location_id)`, `items(product_id)`, and **`items(expiry)`**
(the use-soon view).

## Deliberate modelling calls

- **Two quantities, two tables.** `products.quantity_label` = pack size
  ("950 g"); `items.quantity` = how much *you* hold. Don't conflate.
- **Batches split by expiry.** Same product, different expiry = two item rows
  (expiry is per-instance); same product + same expiry = one row with quantity.
- **Category** is canonical on the product; an item may override (freeform).
- **Image** = BLOB on the product (rides in the mysqldump backup); a `source`
  flag distinguishes OFF vs a photo you took (for products OFF has no image for).
- **Freeform has a floor.** Don't force one-offs into the catalog — that's why
  `product_id` is nullable. Promote to a product only with a barcode or when
  you'll rebuy/track it.
- **Sync (when items join it).** The offline-first layer references rows by ULID
  with nullable hard FKs resolved server-side (see `proposals/offline-first.md`),
  so cross-table links travel as ULIDs; the BIGINT FKs are for local integrity.

## Sync scope (deliberate, not an oversight)

Offline-first sync (RxDB + soft-delete + `rev`/`ulid`) currently covers **only
`shopping_items`** — the one surface you use while walking around a shop with no
signal. `items`/`locations`/`recipes` are **online-only** (plain REST, hard
deletes) **by choice**: inventory is edited at home, on wifi, so the cost of the
per-table sync machinery isn't yet worth it. When that changes, the pattern
(ULID + `rev` + tombstones + the conflict handler) is established and applies
unchanged. So the inconsistency between the two paths is a known trade-off, not
an accident.

## Deferred (not yet built)

`purchases`/`price_observations` (+ optional `shops`), recipe_ingredient →
product links (replace name-matching), items into the RxDB sync (ulid/rev),
extra item fields (opened_at/acquired_at/notes), and dropping the now-redundant
`items.barcode`/`items.name` once all reads go through the product.
