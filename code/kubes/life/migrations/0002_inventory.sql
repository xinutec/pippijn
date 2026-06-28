-- life schema, migration 0002: the generic location/item model.
-- Containment is general asset tracking: item -> layer -> cupboard -> room ->
-- house. Items are generic (category, not food-only) from day one; see
-- docs/design/overview.md §4.

-- A node in the spatial tree. `kind` is house/room/cupboard/fridge/layer.
-- `parent_id` forms the tree; `position` holds optional 3D placement (JSON)
-- for the house model; `sort_order` orders layers within a cupboard.
CREATE TABLE IF NOT EXISTS locations (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    VARCHAR(255)    NOT NULL,
    kind       VARCHAR(20)     NOT NULL,
    name       VARCHAR(255)    NOT NULL,
    parent_id  BIGINT UNSIGNED NULL,
    sort_order INT             NOT NULL DEFAULT 0,
    position   JSON            NULL,
    created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_locations_user (user_id),
    INDEX idx_locations_parent (parent_id),
    CONSTRAINT fk_locations_parent FOREIGN KEY (parent_id)
        REFERENCES locations (id) ON DELETE CASCADE
);

-- A tracked thing. Generic: `category` is food/medication/tool/document/other.
-- `quantity`/`unit`/`expiry` are first-class (not food-only). `location_id`
-- points at the current node (typically a layer).
CREATE TABLE IF NOT EXISTS items (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id     VARCHAR(255)    NOT NULL,
    name        VARCHAR(255)    NOT NULL,
    category    VARCHAR(20)     NOT NULL DEFAULT 'other',
    quantity    DOUBLE          NULL,
    unit        VARCHAR(32)     NULL,
    expiry      DATE            NULL,
    location_id BIGINT UNSIGNED NULL,
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_items_user (user_id),
    INDEX idx_items_location (location_id),
    INDEX idx_items_expiry (expiry),
    CONSTRAINT fk_items_location FOREIGN KEY (location_id)
        REFERENCES locations (id) ON DELETE SET NULL
);

-- Append-only audit of where an item has been. Written on add/move/remove from
-- the start (cheap now, impossible to backfill).
CREATE TABLE IF NOT EXISTS item_history (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    item_id     BIGINT UNSIGNED NOT NULL,
    user_id     VARCHAR(255)    NOT NULL,
    location_id BIGINT UNSIGNED NULL,
    event       VARCHAR(16)     NOT NULL,
    quantity    DOUBLE          NULL,
    at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_item_history_item (item_id),
    CONSTRAINT fk_item_history_item FOREIGN KEY (item_id)
        REFERENCES items (id) ON DELETE CASCADE
);
