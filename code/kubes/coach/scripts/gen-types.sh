#!/usr/bin/env bash
# Generate the frontend TS interfaces from the Rust API types via ts-rs, so the
# backend↔frontend wire shapes are consistent by construction (not transcribed).
#
# Run inside the coach dev shell (cargo on PATH):
#   nix develop --command scripts/gen-types.sh
#
# Output lands in frontend/src/app/generated/ (committed; imported via
# frontend/src/app/models.ts). The drift gate re-runs this and fails if the
# committed output no longer matches the Rust types — see scripts/check-types.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="frontend/src/app/generated"
rm -rf "$OUT"
# ts-rs emits one file per #[ts(export)] type; the export tests are named
# export_bindings_*, so this filter runs only generation (no DB needed). The
# output dir is pinned in .cargo/config.toml (TS_RS_EXPORT_DIR).
cargo test export_bindings >/dev/null 2>&1
echo "generated $(find "$OUT" -name '*.ts' | wc -l | tr -d ' ') type(s) -> $OUT"
