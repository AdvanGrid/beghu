import { highlightCode, classHighlighter } from '@lezer/highlight';
import { parser as js } from '@lezer/javascript';
import { parser as rust } from '@lezer/rust';
export const hl = (c, l, put, br) => highlightCode(c, (l === 'rust' ? rust : js).parse(c), classHighlighter, put, br);
