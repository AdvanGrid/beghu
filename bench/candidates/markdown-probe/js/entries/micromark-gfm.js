import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
export const render = (s) => micromark(s, { allowDangerousHtml: true, extensions: [gfm()], htmlExtensions: [gfmHtml()] });
