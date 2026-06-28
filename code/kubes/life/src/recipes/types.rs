//! Recipe domain types.

use serde::{Deserialize, Serialize};

/// One ingredient line of a recipe. Matched to inventory by `name`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecipeIngredient {
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
}

/// A recipe as returned by the API, ingredients nested.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Recipe {
    pub id: u64,
    pub name: String,
    pub instructions: Option<String>,
    pub servings: Option<i32>,
    pub ingredients: Vec<RecipeIngredient>,
}

/// Request body for creating a recipe.
#[derive(Debug, Deserialize)]
pub struct NewRecipe {
    pub name: String,
    pub instructions: Option<String>,
    pub servings: Option<i32>,
    #[serde(default)]
    pub ingredients: Vec<RecipeIngredient>,
}
