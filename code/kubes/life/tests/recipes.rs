//! Pure recipe↔inventory matching: shopping list and cook-now.

use life::inventory::types::{Item, ItemCategory};
use life::recipes::matching::{can_cook, shopping_list};
use life::recipes::types::RecipeIngredient;

fn ing(name: &str, qty: Option<f64>, unit: Option<&str>) -> RecipeIngredient {
    RecipeIngredient {
        name: name.into(),
        quantity: qty,
        unit: unit.map(Into::into),
    }
}

fn item(name: &str, qty: Option<f64>, unit: Option<&str>) -> Item {
    Item {
        id: 0,
        product_id: None,
        name: name.into(),
        brand: None,
        category: ItemCategory::Food,
        quantity: qty,
        unit: unit.map(Into::into),
        expiry: None,
        location_id: None,
        barcode: None,
        has_image: false,
    }
}

#[test]
fn presence_match_is_case_and_space_insensitive() {
    let recipe = [ing("  Cumin ", None, None)];
    let stock = [item("cumin", None, None)];
    assert!(can_cook(&recipe, &stock));
    assert!(shopping_list(&recipe, &stock).is_empty());
}

#[test]
fn missing_ingredient_goes_on_the_list() {
    let recipe = [ing("cumin", None, None), ing("salt", None, None)];
    let stock = [item("cumin", None, None)];
    let list = shopping_list(&recipe, &stock);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "salt");
    assert!(!can_cook(&recipe, &stock));
}

#[test]
fn quantity_shortfall_is_not_satisfied() {
    let recipe = [ing("flour", Some(500.0), Some("g"))];
    let stock = [item("flour", Some(200.0), Some("g"))];
    assert!(!can_cook(&recipe, &stock));
}

#[test]
fn quantity_summed_across_stock_rows() {
    let recipe = [ing("flour", Some(500.0), Some("g"))];
    let stock = [
        item("flour", Some(300.0), Some("g")),
        item("flour", Some(300.0), Some("g")),
    ];
    assert!(can_cook(&recipe, &stock));
}

#[test]
fn presence_fallback_when_units_differ() {
    // Need grams, but stock is counted in jars — fall back to presence.
    let recipe = [ing("paprika", Some(20.0), Some("g"))];
    let stock = [item("paprika", Some(1.0), Some("jar"))];
    assert!(can_cook(&recipe, &stock));
}
