// The compact Markdown AST the server renders bodies and comments to (crates/md-ast): an element
// is `[tag, attrs | 0, ...children]` and text is a plain string. References are `ref` elements
// with no children: `{o, r, n}` an issue or PR, `{o, r, n, c}` comment `c` on one, `{u}` a user,
// `{t}` a team (`org/team`).

export type MdAttrs = Record<string, string | number>;

export type MdNode = string | [tag: string, attrs: MdAttrs | 0, ...children: MdNode[]];

/** A body or comment: its top-level nodes. */
export type Md = MdNode[];
