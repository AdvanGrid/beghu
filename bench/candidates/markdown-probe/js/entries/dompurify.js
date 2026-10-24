import DOMPurify from 'dompurify';
export const clean = (s) => DOMPurify.sanitize(s);
