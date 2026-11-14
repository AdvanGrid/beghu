// `.br` and `.gz` siblings of a built file, at maximum compression, for the server to send as
// they are (crates/server/src/lib.rs). The edge passes encodings through, so these are the bytes
// on the wire. A sibling that wouldn't be smaller isn't written. Used for the app's assets
// (vite.config.ts) and the public site's (site/build.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export function writeCompressedSiblings(file: string): void {
  const raw = readFileSync(file);
  const br = brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  const gz = gzipSync(raw, { level: constants.Z_BEST_COMPRESSION });
  if (br.length < raw.length) writeFileSync(`${file}.br`, br);
  if (gz.length < raw.length) writeFileSync(`${file}.gz`, gz);
}
