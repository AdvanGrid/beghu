import { sanitize, defaultSchema } from 'hast-util-sanitize';
export const clean = (t) => sanitize(t, defaultSchema);
