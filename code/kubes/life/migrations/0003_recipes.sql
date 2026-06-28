-- life schema, migration 0003: recipes.
-- A recipe is a name + method + an ordered list of ingredients. Ingredients
-- are matched to inventory by name (case-insensitive) to derive "cook now" and
-- "shopping list = recipe − stock"; see docs/design/overview.md §4.

CREATE TABLE IF NOT EXISTS recipes (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id      VARCHAR(255)    NOT NULL,
    name         VARCHAR(255)    NOT NULL,
    instructions TEXT            NULL,
    servings     INT             NULL,
    created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_recipes_user (user_id)
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    recipe_id  BIGINT UNSIGNED NOT NULL,
    name       VARCHAR(255)    NOT NULL,
    quantity   DOUBLE          NULL,
    unit       VARCHAR(32)     NULL,
    sort_order INT             NOT NULL DEFAULT 0,
    INDEX idx_recipe_ingredients_recipe (recipe_id),
    CONSTRAINT fk_recipe_ingredients_recipe FOREIGN KEY (recipe_id)
        REFERENCES recipes (id) ON DELETE CASCADE
);
