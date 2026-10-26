// What the router imports from `@solidjs/web/server-functions`, for an app with no Solid server
// functions. beghu's server is Rust: its queries return plain JSON from its own API, it posts no
// forms to server actions, and nothing sends single-flight payloads. The real module is about
// 5 KB gzip of first-load JS doing none of that; vite.config.ts points the router's import here.
// A router update importing anything else fails the build, which is the cue to look again.
//
// Whoever bumps @solidjs/router (or @solidjs/web) must re-diff the router's imports from
// `@solidjs/web/server-functions` and what it does with each, against this stub, even when the
// build passes: a name it already imports can change meaning without failing anything.

/** The header a server function carries a masked redirect in; never set by beghu. */
export const REDIRECT_HEADER = "X-Server-Function-Redirect";

/** No server function redirects: there's never a carried one to decode. */
export function decodeRedirectHeaderValue(_value: string | null): undefined {
  return undefined;
}

/** Nothing delivers single-flight data, so there's nothing to subscribe to. */
export function subscribeFlightData(_consumer: unknown): () => void {
  return () => {};
}

/** No URL is a server action's, so the router never intercepts a form post as one. */
export function parseServerFunctionActionUrl(_url: string): undefined {
  return undefined;
}

function unused(name: string): never {
  throw new Error(`${name}: beghu has no Solid server functions (see src/no-server-functions.ts)`);
}

export function createServerReference(..._args: unknown[]): never {
  return unused("createServerReference");
}

export function decodeResponsePayload(_response: Response): never {
  return unused("decodeResponsePayload");
}
