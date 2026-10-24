import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toHast } from 'mdast-util-to-hast';
export const render = (s) => toHast(fromMarkdown(s, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }), { allowDangerousHtml: true });
