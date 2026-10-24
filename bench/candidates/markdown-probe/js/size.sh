#!/bin/sh
# Bundles each entry with esbuild (minified, browser ESM) and prints raw / gzip -9 / brotli bytes.
mkdir -p out
printf '%-16s %8s %8s %8s\n' entry min gzip br
for f in entries/*.js; do n=$(basename $f .js)
  npx esbuild $f --bundle --minify --format=esm --platform=browser --log-level=error --outfile=out/$n.js || continue
  printf '%-16s %8d %8d %8d\n' $n $(wc -c <out/$n.js) $(gzip -9c out/$n.js | wc -c) $(brotli -c out/$n.js 2>/dev/null | wc -c)
done
