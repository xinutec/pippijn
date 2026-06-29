-- Life schema, migration 0007: split the product *catalog* from item *holdings*.
--
-- `products` was an Open Food Facts cache keyed by barcode. It becomes the
-- catalog: your personal list of "what a thing is" (some rows from OFF, some
-- hand-defined), keyed by a surrogate id with an OPTIONAL unique barcode. An
-- `item` (a thing you actually own) links to a product via `product_id`, or
-- stands alone with its own `name` (one-offs with no barcode). This is the
-- catalog-vs-inventory split — see docs/design/catalog-and-holdings.md.
--
-- Single-user app, so `products` is simply Pippijn's catalog (no per-user
-- sharing concerns). Additive + backfilled; the redundant items.barcode/name
-- are kept for now and dropped in a later migration once reads go via product.

-- products: surrogate id PK + optional, unique barcode + catalog fields.
ALTER TABLE products MODIFY COLUMN barcode VARCHAR(32) NULL;
ALTER TABLE products DROP PRIMARY KEY;
ALTER TABLE products ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST;
ALTER TABLE products ADD UNIQUE KEY uniq_products_barcode (barcode);
ALTER TABLE products ADD COLUMN category VARCHAR(20) NULL;
ALTER TABLE products ADD COLUMN source VARCHAR(16) NULL;
ALTER TABLE products
    ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Existing catalog rows all came from Open Food Facts.
UPDATE products SET source = 'off' WHERE source IS NULL;

-- items: optional link to the catalog. `name` becomes a fallback used only when
-- product_id IS NULL (existing names are kept).
ALTER TABLE items ADD COLUMN product_id BIGINT UNSIGNED NULL AFTER user_id;
ALTER TABLE items MODIFY COLUMN name VARCHAR(255) NULL;
ALTER TABLE items ADD INDEX idx_items_product (product_id);
ALTER TABLE items ADD CONSTRAINT fk_items_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL;

-- Backfill: link each already-barcoded item to its catalog product (the OFF
-- cache already holds a row per scanned barcode).
UPDATE items i JOIN products p ON p.barcode = i.barcode
    SET i.product_id = p.id
    WHERE i.barcode IS NOT NULL;
