// Probe instrumentation: which build is running, and every load failure, for the driver to read.
declare const __BUILD__: string;
export const BUILD = __BUILD__;

type Probe = { build: string; errors: string[]; preloadErrors: string[]; shows: { persisted: boolean; build: string }[] };
const w = window as unknown as { __probe: Probe };
w.__probe = { build: BUILD, errors: [], preloadErrors: [], shows: [] };
document.documentElement.dataset.build = BUILD;

addEventListener('error', (e) => w.__probe.errors.push(`error: ${e.message}`));
addEventListener('unhandledrejection', (e) => w.__probe.errors.push(`rejection: ${String(e.reason)}`));
addEventListener('pageshow', (e) => w.__probe.shows.push({ persisted: e.persisted, build: BUILD }));
// Vite's documented hook for a dynamic import whose chunk is gone. RECOVER=1 reloads once per URL.
addEventListener('vite:preloadError', (e) => {
  const err = (e as Event & { payload: Error }).payload;
  w.__probe.preloadErrors.push(`${err?.name}: ${err?.message} @${location.pathname}`);
  try {
    if (localStorage.getItem('recover') === '1' && sessionStorage.getItem('reloaded') !== location.href) {
      sessionStorage.setItem('reloaded', location.href);
      e.preventDefault();
      location.reload();
    }
  } catch {}
});
