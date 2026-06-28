//! Pure recipe↔inventory matching: "shopping list = recipe − stock" and
//! "can I cook this now". Kept free of the DB so it is unit-tested directly.

use super::types::RecipeIngredient;
use crate::inventory::types::Item;

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

/// Whether the inventory satisfies one ingredient. Name-matched
/// case-insensitively. When the ingredient gives a quantity AND some stock of
/// the same unit also gives quantities, the summed stock must meet the amount;
/// otherwise presence of a name match is enough.
fn is_satisfied(ingredient: &RecipeIngredient, inventory: &[Item]) -> bool {
    let want_name = norm(&ingredient.name);
    let matches: Vec<&Item> = inventory
        .iter()
        .filter(|it| norm(&it.name) == want_name)
        .collect();
    if matches.is_empty() {
        return false;
    }
    match (ingredient.quantity, ingredient.unit.as_deref()) {
        (Some(needed), Some(unit)) => {
            let want_unit = norm(unit);
            let available: f64 = matches
                .iter()
                .filter(|it| it.unit.as_deref().map(norm).as_deref() == Some(want_unit.as_str()))
                .filter_map(|it| it.quantity)
                .sum();
            // No comparable-unit quantities on hand → fall back to presence.
            if available == 0.0 {
                true
            } else {
                available >= needed
            }
        }
        _ => true,
    }
}

/// The ingredients NOT covered by current inventory — i.e. the shopping list.
pub fn shopping_list(
    ingredients: &[RecipeIngredient],
    inventory: &[Item],
) -> Vec<RecipeIngredient> {
    ingredients
        .iter()
        .filter(|ing| !is_satisfied(ing, inventory))
        .cloned()
        .collect()
}

/// True if every ingredient is satisfied by current inventory.
pub fn can_cook(ingredients: &[RecipeIngredient], inventory: &[Item]) -> bool {
    shopping_list(ingredients, inventory).is_empty()
}
