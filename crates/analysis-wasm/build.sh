#!/usr/bin/env bash
# Builds validate.mjs and merge.mjs: the analysis crate compiled to WASM and inlined as base64
# into two single Node files that need no npm install.
#
#   crates/analysis-wasm/build.sh [out dir]      (default: target/analysis-tools)
#
# Needs the wasm32-unknown-unknown target (`rustup target add wasm32-unknown-unknown`) and
# wasm-bindgen-cli at the version Cargo.lock pins for the wasm-bindgen crate
# (`cargo install wasm-bindgen-cli --version <it> --locked`): the two must match.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="${1:-$root/target/analysis-tools}"
target_dir="${CARGO_TARGET_DIR:-$root/target}"

want="$(awk '$0 == "name = \"wasm-bindgen\"" { getline; gsub(/version = |"/, ""); print }' "$root/Cargo.lock")"
have="$(wasm-bindgen --version 2>/dev/null | awk '{ print $2 }')" || true
if [ "$want" != "$have" ]; then
  echo "wasm-bindgen-cli ${have:-is missing}; the crate is $want:" >&2
  echo "  cargo install wasm-bindgen-cli --version $want --locked" >&2
  exit 1
fi

# Size over speed, for the WASM build only: the module is inlined into each file.
CARGO_PROFILE_RELEASE_OPT_LEVEL=s CARGO_PROFILE_RELEASE_LTO=true CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
  CARGO_PROFILE_RELEASE_PANIC=abort CARGO_PROFILE_RELEASE_STRIP=true \
  cargo build --locked --release -p analysis-wasm --target wasm32-unknown-unknown
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
wasm-bindgen --target web --no-typescript --out-dir "$tmp" \
  "$target_dir/wasm32-unknown-unknown/release/analysis_wasm.wasm"

mkdir -p "$out"
module="$(base64 < "$tmp/analysis_wasm_bg.wasm" | tr -d '\n')"
for tool in validate merge; do
  {
    echo '#!/usr/bin/env node'
    echo "// beghu's ${tool}.mjs, built by crates/analysis-wasm/build.sh from the analysis crate. One"
    echo '// file: the WASM module is inlined below as base64, so it needs Node and nothing else.'
    echo '// Run it with --help for its usage.'
    cat "$tmp/analysis_wasm.js"
    echo "const MODULE = \"$module\";"
    echo 'initSync({ module: Buffer.from(MODULE, "base64") });'
    cat "$here/js/$tool.js"
  } > "$out/$tool.mjs"
done
echo "built $out/validate.mjs and $out/merge.mjs ($(wc -c < "$out/validate.mjs") bytes each)"
