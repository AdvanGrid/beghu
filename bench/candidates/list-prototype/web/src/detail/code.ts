// PROTOTYPE (beghu #54). Colours fenced code blocks by their language. highlight.js core plus a
// handful of languages, loaded on first use so the detail's first paint doesn't wait for it: the
// block shows as plain monospace text, then takes its colours in place (same text, no shift).
// Which markdown renderer and highlighter v1 uses is "Markdown rendering for bodies and comments".
import { createSignal } from 'solid-js';
import type { HLJSApi } from 'highlight.js';

const [hljs, setHljs] = createSignal<HLJSApi | undefined>(undefined);
let loading = false;

function load() {
  if (loading) return;
  loading = true;
  Promise.all([
    import('highlight.js/lib/core'),
    import('highlight.js/lib/languages/typescript'),
    import('highlight.js/lib/languages/javascript'),
    import('highlight.js/lib/languages/rust'),
    import('highlight.js/lib/languages/json'),
    import('highlight.js/lib/languages/bash'),
    import('highlight.js/lib/languages/sql'),
    import('highlight.js/lib/languages/css'),
    import('highlight.js/lib/languages/xml'),
    import('highlight.js/lib/languages/yaml'),
    import('highlight.js/lib/languages/diff'),
  ]).then(([core, ts, js, rust, json, bash, sql, css, xml, yaml, diff]) => {
    const h = core.default;
    for (const [name, lang] of [['typescript', ts], ['javascript', js], ['rust', rust], ['json', json], ['bash', bash], ['sql', sql], ['css', css], ['xml', xml], ['yaml', yaml], ['diff', diff]] as const)
      h.registerLanguage(name, lang.default);
    h.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
    h.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
    h.registerAliases(['rs'], { languageName: 'rust' });
    h.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' });
    h.registerAliases(['html'], { languageName: 'xml' });
    h.registerAliases(['yml'], { languageName: 'yaml' });
    setHljs(h);
  });
}

export type Segment = { text: string } | { code: string; lang: string };

/** Splits text into prose and ``` fenced blocks. An unclosed fence runs to the end. */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /^```([\w+-]*)[^\n]*\n([\s\S]*?)(?:^```[ \t]*$|(?![\s\S]))/gm;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) out.push({ text: text.slice(last, m.index).replace(/\n$/, '') });
    out.push({ code: m[2].replace(/\n$/, ''), lang: m[1].toLowerCase() });
    last = re.lastIndex;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  if (last < text.length) out.push({ text: text.slice(last).replace(/^\n/, '') });
  return out;
}

/** Highlighted HTML once highlight.js is loaded, or undefined (render the plain text meanwhile).
 * A language it doesn't know stays plain. */
export function highlight(code: string, lang: string): string | undefined {
  const h = hljs();
  if (!h) {
    load();
    return undefined;
  }
  if (!lang || !h.getLanguage(lang)) return undefined;
  return h.highlight(code, { language: lang, ignoreIllegals: true }).value;
}
