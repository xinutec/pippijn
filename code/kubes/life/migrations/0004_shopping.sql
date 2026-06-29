-- Life schema, migration 0004: the shopping list ("things I need to buy").
-- Separate from `items` (things you HAVE). Checking one off as bought can
-- convert it into an inventory item (see the /buy route).

CREATE TABLE IF NOT EXISTS shopping_items (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    VARCHAR(255)    NOT NULL,
    name       VARCHAR(255)    NOT NULL,
    quantity   DOUBLE          NULL,
    unit       VARCHAR(32)     NULL,
    done       TINYINT(1)      NOT NULL DEFAULT 0,
    created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_shopping_user (user_id)
);
