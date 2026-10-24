import { marked } from 'marked';
export const render = (s) => marked.parse(s, { gfm: true });
