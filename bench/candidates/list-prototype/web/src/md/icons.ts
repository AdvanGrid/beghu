// PROTOTYPE (beghu #68). Icons for the Markdown styles, two ways (the `icons` knob on the bar):
// - svg: one inline <svg> sprite of <symbol>s, injected once; each use is <svg><use href="#…">.
//   Costs no request and no font, takes currentColor, and is identical on every OS.
// - glyph: plain Unicode characters in the text font. No sprite, but shapes and widths vary by OS
//   font, and some fall back to emoji.
export type IconMode = 'svg' | 'glyph';

const PATHS: Record<string, string> = {
  info: '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="4.75" r="1" fill="currentColor"/>',
  bulb: '<path d="M8 1.75a4.25 4.25 0 0 0-2.6 7.6c.5.4.85.95.85 1.6v.3h3.5v-.3c0-.65.35-1.2.85-1.6A4.25 4.25 0 0 0 8 1.75Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6.25 13.75h3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  report: '<path d="M2.75 2.75h10.5v8h-6l-3 2.5v-2.5h-1.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 4.75v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="9.4" r=".9" fill="currentColor"/>',
  alert: '<path d="M8 2.25 14.25 13.5H1.75z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".9" fill="currentColor"/>',
  stop: '<path d="M5.5 1.75h5l3.75 3.75v5l-3.75 3.75h-5L1.75 10.5v-5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 4.75v3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="10.75" r=".9" fill="currentColor"/>',
  globe: '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.75 8h12.5M8 1.75c-2.2 2.3-2.2 10.2 0 12.5M8 1.75c2.2 2.3 2.2 10.2 0 12.5" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  github: '<path d="M8 1.5a6.5 6.5 0 0 0-2.06 12.67c.33.06.44-.14.44-.31v-1.1c-1.8.39-2.18-.87-2.18-.87-.3-.75-.72-.95-.72-.95-.59-.4.04-.4.04-.4.65.05 1 .67 1 .67.58 1 1.52.71 1.9.54.05-.42.22-.71.4-.87-1.44-.16-2.96-.72-2.96-3.2 0-.71.25-1.29.67-1.74-.07-.17-.29-.83.06-1.72 0 0 .55-.18 1.79.66a6.2 6.2 0 0 1 3.26 0c1.24-.84 1.79-.66 1.79-.66.35.89.13 1.55.06 1.72.42.45.67 1.03.67 1.74 0 2.49-1.52 3.04-2.97 3.2.23.2.44.6.44 1.2v1.78c0 .17.11.38.45.31A6.5 6.5 0 0 0 8 1.5Z" fill="currentColor"/>',
  mail: '<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m2.25 4 5.75 4.5L13.75 4" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  image: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.5" cy="6.25" r="1.25" fill="currentColor"/><path d="m2.5 12 4-4 2.5 2.5L11 8.5l3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  code: '<path d="M5.5 4 1.75 8l3.75 4M10.5 4l3.75 4-3.75 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  'issue-open': '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/>',
  'issue-done': '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m5.25 8.25 1.9 1.9 3.6-3.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  'issue-np': '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m3.75 12.25 8.5-8.5" stroke="currentColor" stroke-width="1.5"/>',
};

const GLYPH: Record<string, string> = {
  info: 'ⓘ', bulb: '✦', report: '❢', alert: '⚠', stop: '⊘', globe: '◍', github: '⌥', mail: '✉', image: '▣', code: '‹›',
  'issue-open': '◉', 'issue-done': '✓', 'issue-np': '⊘',
};

let injected = false;
function inject() {
  if (injected) return;
  injected = true;
  const s = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${Object.entries(PATHS)
    .map(([k, p]) => `<symbol id="mdi-${k}" viewBox="0 0 16 16">${p}</symbol>`)
    .join('')}</svg>`;
  document.body.insertAdjacentHTML('afterbegin', s);
}

const NS = 'http://www.w3.org/2000/svg';
export function icon(name: string, mode: IconMode, cls = ''): Node {
  if (mode === 'glyph') {
    const s = document.createElement('span');
    s.className = `md-icon md-glyph ${cls}`;
    s.setAttribute('aria-hidden', 'true');
    s.textContent = GLYPH[name] ?? '•';
    return s;
  }
  inject();
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `md-icon ${cls}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#mdi-${name}`);
  svg.append(use);
  return svg;
}
