#!/usr/bin/env python3

import http.client
import json
import os
import pprint
import urllib.parse
from typing import Any

# Reference Daily Intake
RDI_TABLE = "mamm9dpys1j1znw"

# Nutrients (for ingredients per 100g)
NUTRIENTS_TABLE = "m0zj43gvvzeqxqz"

# Ingredients (ingredients, but in actual weight when put on a plate)
INGREDIENTS_TABLE = "m5ddsw6b8q0jn55"

# Dishes (collections of weighted ingredients from Recipes)
DISHES_TABLE = "mtmdui21lnhz8wq"
DISHES_LINK_RECIPES = "c86u2iy3l11rm40"

# Recipes (amounts of ingredients for a given dish)
RECIPES_TABLE = "mzritn6zi79bir9"

# Meals (dated collections of ingredients)
MEALS_TABLE = "mohjrlr1l7et77g"
MEALS_VIEW_TODAY = "vwpckbejvg1mbifx"
MEALS_LINK_INGREDIENTS = "cc9wqhoe8nfb18o"
MEALS_LINK_DISHES = "c055jl2zkxeup5z"


def process_nutrients(rdi: dict[str, Any], ingredient_amount: Any,
                      ingredient: dict[str, Any]) -> dict[str, Any]:
    """Compute all nutrients for an ingredient based on the amount."""
    nutrients = {"Amount (g)": ingredient_amount}
    for k, v in ingredient.items():
        if v is None or k == "Name":
            nutrients[k] = v
        elif k in rdi:
            amount = v / 100 * ingredient_amount
            nutrients[k] = {"Amount": amount, "RDI": amount / rdi[k]["Amount"]}
    return nutrients


def sum_amounts(total: dict[str, Any], ingredients: Any) -> None:
    """Sum up all the amounts and RDI values of all nutrients to a total."""
    for ingredient in ingredients:
        for k, v in ingredient.items():
            if isinstance(v, dict):
                if k not in total:
                    total[k] = {"Amount": 0, "RDI": 0}
                total[k]["Amount"] += v["Amount"]
                total[k]["RDI"] += v["RDI"]


def compute_total(ingredients: tuple[Any, ...]) -> tuple[Any, ...]:
    """Create a new Total ingredient and add it to the end of the ingredients."""
    total = {"Name": "Total", "Amount (g)": None}
    sum_amounts(total, ingredients)
    return ingredients + (total,)


def sort_by_amount(ingredients: Any) -> tuple[Any, ...]:
    return tuple(sorted(ingredients, reverse=True, key=lambda ingredient: ingredient["Amount (g)"]))


class HealthDb:
    def __init__(self) -> None:
        self.conn = http.client.HTTPSConnection("nocodb.xinutec.org")
        self.headers = {'xc-token': os.environ["NOCODB_TOKEN"]}

    def get(self, url: str) -> Any:
        """GET a URL and JSON-decode the success-response."""
        self.conn.request("GET", url, headers=self.headers)

        res = self.conn.getresponse()
        return json.loads(res.read().decode("utf-8"))["list"]

    def list_table_records(self, table: str, view: str = "", fields: tuple[str, ...] = tuple(), key: str = "Id", sort_key: str = "") -> dict[Any, Any]:
        """Retrieve records from a specified table/view, create a dict keyed by a given column."""
        fields_encoded = ",".join(map(urllib.parse.quote_plus, fields))
        return {
            rec[key]: rec
            for rec in self.get(
                f"/api/v2/tables/{table}/records?offset=0&limit=1000&viewId={view}&fields={fields_encoded}&sort={sort_key}")
        }

    def list_linked_records(self, table: str, link_field_id: str, record_id: int, key: str = "Id") -> dict[Any, Any]:
        """Retrieve list of linked records for a specific Link field and Record ID."""
        return {
            rec[key]: rec
            for rec in self.get(
                f"/api/v2/tables/{table}/links/{link_field_id}/records/{record_id}")
        }

    def today(self) -> tuple[Any, Any, Any]:
        """Compute nutrient intake for the current day."""
        rdi = self.list_table_records(
            RDI_TABLE,
            fields=("Class", "Nutrient", "Amount"),
            key="Nutrient", sort_key="-Class,-Nutrient",
        )
        nutrients = self.list_table_records(NUTRIENTS_TABLE)
        recipes = self.list_table_records(
            RECIPES_TABLE,
            fields=("Id", "Amount (g)", "Nutrient"),
        )
        ingredients = self.list_table_records(
            INGREDIENTS_TABLE,
            fields=("Id", "Amount (g)", "Ingredient"),
        )
        meals = self.list_table_records(MEALS_TABLE, view=MEALS_VIEW_TODAY)
        for mealId in tuple(meal["Id"] for meal in meals.values()):
            meals[mealId]["Ingredients"] = sort_by_amount(process_nutrients(
                rdi, ingredients[k]["Amount (g)"], nutrients[ingredients[k]["Ingredient"]["Id"]]
            ) for k in self.list_linked_records(MEALS_TABLE, MEALS_LINK_INGREDIENTS, mealId).keys())
            for dish in self.list_linked_records(MEALS_TABLE, MEALS_LINK_DISHES, mealId).values():
                meals[f"{mealId}:{dish['Id']}"] = {
                    "Meal": f"{meals[mealId]['Meal']} - {dish['Name']}",
                    "Ingredients": sort_by_amount(process_nutrients(
                        rdi, recipes[k]["Amount (g)"], nutrients[recipes[k]["Nutrient"]["Id"]]
                    ) for k in self.list_linked_records(DISHES_TABLE, DISHES_LINK_RECIPES, dish["Id"]).keys()),
                }
        table = {}
        for meal in sorted(meals.values(), key=lambda meal: meal["Meal"]):
            if meal["Ingredients"]:
                table[meal["Meal"]] = compute_total(meal["Ingredients"])
        return table, next(iter(meals.values()))["Date"], tuple(rdi.keys()) + ("Amount (g)",)


def format_amount(amount: Any) -> str:
    """Render an amount or amount with RDI to string."""
    if isinstance(amount, dict):
        rdi = int(round(amount['RDI'] * 100, 0))
        return f"{round(amount['Amount'], 2):7} ({rdi:3}%)"
    elif isinstance(amount, int) or isinstance(amount, float):
        return f"{round(amount, 2):7}"
    else:
        return ""


def nutrient_order(nutrient_names: tuple[Any, ...], k: str) -> int:
    if k not in nutrient_names:
        raise ValueError(f"`{k}` not in nutrient names")
    return -nutrient_names.index(k)


def print_ingredients(ingredients: Any, nutrient_names: Any) -> None:
    keys = sorted(
        (k for k in ingredients[0].keys() if k not in ("Name", "UpdatedAt")),
        key=lambda k: nutrient_order(nutrient_names, k),
    )
    padding = max(len(k) for k in keys)
    min_col_width = 14
    title = ("| " + " " * padding + " | " +
             " | ".join(f"{ingredient['Name']:{min_col_width}}"
                        for ingredient in ingredients))
    print(title)
    print("| :" + "-" * (padding - 1) + " | " +
          " | ".join("-" * (max(len(ingredient["Name"]), min_col_width) - 1) + ":"
                     for ingredient in ingredients))
    for k in keys:
        print(f"| {k:{padding}} | " +
              " | ".join(f"{format_amount(ingredient.get(k, None)):{max(len(ingredient['Name']), min_col_width)}}"
                         for ingredient in ingredients))


def main() -> None:
    db = HealthDb()

    total = {"Name": "Total"}

    meals, date, nutrient_names = db.today()
    print(f"# {date}")
    for meal, ingredients in meals.items():
        print(f"\n## {meal}\n")
        print_ingredients(ingredients, nutrient_names)

        sum_amounts(total, (ingredient for ingredient in ingredients if ingredient["Name"] == "Total"))

    print(f"\n## Total\n")
    print_ingredients([total], nutrient_names)


if __name__ == "__main__":
    main()
