#!/usr/bin/env nix-shell
#!nix-shell -i bash -p curl jq
# Seed a demo house (rooms, cupboards, layers, items, a recipe) for local dev.
# Requires the server running with DEV_LOGIN_USER set (see .env). Idempotent it
# is NOT — re-running adds duplicates; reset with scripts/dev-db.sh + drop .dev.
#
#   ./scripts/seed-demo.sh
#   BASE=http://127.0.0.1:8080 ./scripts/seed-demo.sh
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8080}"
COOKIES="$(mktemp)"
trap 'rm -f "$COOKIES"' EXIT

# Establish a dev session (no Nextcloud).
curl -fsS -c "$COOKIES" -L "$BASE/dev-login" -o /dev/null

# POST JSON to a path, echo the created row's id.
mk() { # mk <path> <json>
    curl -fsS -b "$COOKIES" -H 'Content-Type: application/json' -d "$2" "$BASE$1"
}
loc() { mk /api/locations "$1" | jq -r '.id'; }

house=$(loc '{"kind":"house","name":"Home"}')

kitchen=$(loc "$(jq -nc --argjson p '{"x":0,"z":0,"w":4,"d":3}' --arg parent "$house" \
    '{kind:"room",name:"Kitchen",parent_id:($parent|tonumber),position:$p}')")
pantry=$(loc "$(jq -nc --argjson p '{"x":4,"z":0,"w":2,"d":3}' --arg parent "$house" \
    '{kind:"room",name:"Pantry",parent_id:($parent|tonumber),position:$p}')")

spice=$(loc "$(jq -nc --argjson p '{"x":0.2,"z":0.2,"w":0.8,"d":0.4,"h":2.0}' --arg parent "$kitchen" \
    '{kind:"cupboard",name:"Spice cupboard",parent_id:($parent|tonumber),position:$p}')")
shelves=$(loc "$(jq -nc --argjson p '{"x":4.2,"z":0.2,"w":1.6,"d":0.4,"h":2.2}' --arg parent "$pantry" \
    '{kind:"cupboard",name:"Pantry shelves",parent_id:($parent|tonumber),position:$p}')")

# Layers (sort_order = vertical slot).
spice_top=$(loc "$(jq -nc --arg p "$spice" '{kind:"layer",name:"Top shelf",parent_id:($p|tonumber),sort_order:0}')")
spice_bot=$(loc "$(jq -nc --arg p "$spice" '{kind:"layer",name:"Bottom shelf",parent_id:($p|tonumber),sort_order:1}')")
pantry_l1=$(loc "$(jq -nc --arg p "$shelves" '{kind:"layer",name:"Shelf 1",parent_id:($p|tonumber),sort_order:0}')")

# Items.
item() { mk /api/items "$1" >/dev/null; }
item "$(jq -nc --arg l "$spice_top" '{name:"Cumin",category:"food",quantity:1,unit:"jar",location_id:($l|tonumber)}')"
item "$(jq -nc --arg l "$spice_top" '{name:"Paprika",category:"food",quantity:1,unit:"jar",location_id:($l|tonumber)}')"
item "$(jq -nc --arg l "$spice_bot" '{name:"Salt",category:"food",quantity:500,unit:"g",location_id:($l|tonumber)}')"
item "$(jq -nc --arg l "$pantry_l1" '{name:"Rice",category:"food",quantity:2,unit:"kg",location_id:($l|tonumber)}')"
item "$(jq -nc --arg l "$pantry_l1" '{name:"Flour",category:"food",quantity:1,unit:"kg",location_id:($l|tonumber)}')"

# A recipe missing one ingredient (lentils) → non-empty shopping list.
mk /api/recipes '{"name":"Dal","instructions":"Simmer lentils with spices.","servings":2,
  "ingredients":[{"name":"cumin"},{"name":"salt","quantity":5,"unit":"g"},{"name":"lentils","quantity":200,"unit":"g"}]}' >/dev/null

echo "Seeded demo house. Open the Inventory tab to see the items."
