-- Life schema, migration 0005: product reference cache + barcodes on items.
-- `products` caches Open Food Facts lookups (name/brand/image) keyed by
-- barcode, shared (not per-user) since it's reference data. Items and shopping
-- items can carry a barcode to link to it.

CREATE TABLE IF NOT EXISTS products (
    barcode        VARCHAR(32)  NOT NULL PRIMARY KEY,
    name           VARCHAR(255) NULL,
    brand          VARCHAR(255) NULL,
    quantity_label VARCHAR(64)  NULL,
    image          LONGBLOB     NULL,
    image_mime     VARCHAR(64)  NULL,
    fetched_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE items ADD COLUMN IF NOT EXISTS barcode VARCHAR(32) NULL;
ALTER TABLE shopping_items ADD COLUMN IF NOT EXISTS barcode VARCHAR(32) NULL;
