import MarkdownIt from 'markdown-it';
import tasks from 'markdown-it-task-lists';
import footnote from 'markdown-it-footnote';
const md = new MarkdownIt({ html: true, linkify: true }).use(tasks).use(footnote);
export const render = (s) => md.render(s);
