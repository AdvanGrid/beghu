// beghu's own lint rules for the web app (see eslint.config.js):
//
// - no-colour-literals: colours come only from the token modules (src/tokens.stylex.ts, and
//   src/md/tokens.stylex.ts for posts' Markdown and code highlighting). Flags a
//   colour function (rgb(), oklch(), light-dark(), …) in any string, a string that is a hex
//   colour, and inside StyleX calls any hex, named or system colour.
// - no-class-or-style: elements take `{...stylex.attrs(…)}`, or `class={…}` bound to a class
//   string StyleX made once (src/cx.ts; meant for elements built by the thousand, such as the
//   list's rows, but allowed on any element): the value must be a
//   module-level `const` made by a function imported from the cx module (or an object or array
//   literal of those), an entry of one (`ROW_LOOK[look()]`, `CELL.ref`), or a choice of two such
//   (`a ? X : Y`). No class string is written by hand, and none is computed per element.
//   `style={{ "--name": value }}` may set CSS custom properties, which static styles read; it sets
//   nothing else. No `className`, `classList`, other `style`, or namespaced form of them
//   (`prop:className`, `attr:class`, `class:x`, `style:x`).
// - one-escape-stylesheet: the only `.css` import is the escape stylesheet, src/escape.css.
// - no-css-colours: the same colour rule for the escape stylesheet itself (@eslint/css).

const COLOUR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\s*\(/i;
const HEX = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![0-9a-z_-])/i;
const HEX_ONLY = /^\s*#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\s*$/i;
const COLOUR_FNS = new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "light-dark"]);

// CSS named colours and system colours. `transparent` and `currentColor` aren't palette
// choices, so they're allowed.
const NAMED = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
    "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
    "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
    "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen " +
    "mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace " +
    "olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred " +
    "papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue " +
    "saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey " +
    "snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow " +
    "yellowgreen accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas " +
    "canvastext field fieldtext graytext highlight highlighttext linktext mark marktext selecteditem " +
    "selecteditemtext visitedtext"
  ).split(" "),
);

const STYLEX_CALLS = new Set(["create", "defineVars", "defineConsts", "createTheme", "keyframes", "firstThatWorks"]);

/** Whether `ancestors` (innermost last) put a node inside a JSX `style` attribute's value. */
function inJsxStyle(ancestors) {
  return ancestors.some((a) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === "style");
}

function inStylexCall(ancestors) {
  return ancestors.some(
    (a) =>
      a.type === "CallExpression" &&
      a.callee.type === "MemberExpression" &&
      a.callee.object.type === "Identifier" &&
      a.callee.object.name === "stylex" &&
      a.callee.property.type === "Identifier" &&
      STYLEX_CALLS.has(a.callee.property.name),
  );
}

function colourIn(text, strict) {
  if (COLOUR_FN.test(text)) return "a colour function";
  if (HEX_ONLY.test(text)) return "a hex colour";
  if (!strict) return null;
  if (HEX.test(text)) return "a hex colour";
  const named = text
    .toLowerCase()
    .split(/[\s,()/]+/)
    .find((w) => NAMED.has(w));
  return named ? `the colour "${named}"` : null;
}

const noColourLiterals = {
  meta: {
    type: "problem",
    docs: { description: "Colours come only from the token modules" },
    messages: { colour: "{{what}} outside the token modules: use a colour token from src/tokens.stylex.ts or src/md/tokens.stylex.ts" },
    schema: [],
  },
  create(context) {
    const check = (node, text) => {
      if (typeof text !== "string") return;
      // A custom property set in JSX is a style value too.
      const ancestors = context.sourceCode.getAncestors(node);
      const strict = inStylexCall(ancestors) || inJsxStyle(ancestors);
      const what = colourIn(text, strict);
      if (what) context.report({ node, messageId: "colour", data: { what: what[0].toUpperCase() + what.slice(1) } });
    };
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
    };
  },
};

/** The module of StyleX class constants (src/cx.ts), as an import names it. */
const CX_MODULE = /(?:^|\/)cx(?:\.ts)?$/;

/** The variable `id` names, from the scope it's read in. */
function variableOf(scope, id) {
  for (let s = scope; s; s = s.upper) {
    const v = s.set.get(id.name);
    if (v) return v;
  }
  return undefined;
}

/** Whether `node` calls a function imported from the cx module. */
function isCxCall(scope, node) {
  if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return false;
  const def = variableOf(scope, node.callee)?.defs[0];
  return def?.type === "ImportBinding" && def.parent.type === "ImportDeclaration" && CX_MODULE.test(def.parent.source.value);
}

/** A cx call, or an object or array literal whose every value is one (tables of class strings). */
function isCxValue(scope, node) {
  if (isCxCall(scope, node)) return true;
  if (node.type === "ArrayExpression") return node.elements.length > 0 && node.elements.every((e) => e !== null && isCxValue(scope, e));
  if (node.type === "ObjectExpression") {
    return node.properties.length > 0 && node.properties.every((p) => p.type === "Property" && p.kind === "init" && !p.computed && isCxValue(scope, p.value));
  }
  return false;
}

/** Whether `id` names a module-level `const` whose value is a cx value. */
function isCxConst(scope, id) {
  const v = variableOf(scope, id);
  const def = v?.defs[0];
  return (
    v !== undefined &&
    v.defs.length === 1 &&
    v.scope.type === "module" &&
    def.type === "Variable" &&
    def.parent.kind === "const" &&
    def.node.id.type === "Identifier" &&
    def.node.init !== null &&
    isCxValue(v.scope, def.node.init)
  );
}

/** A `class` value the lint allows: a cx constant, an entry of one, or a choice between two such. */
function isCxClass(scope, node) {
  switch (node.type) {
    case "Identifier":
      return isCxConst(scope, node);
    case "MemberExpression": {
      let o = node;
      while (o.type === "MemberExpression" || o.type === "TSNonNullExpression") o = o.type === "MemberExpression" ? o.object : o.expression;
      return o.type === "Identifier" && isCxConst(scope, o);
    }
    case "TSNonNullExpression":
      return isCxClass(scope, node.expression);
    case "ConditionalExpression":
      return isCxClass(scope, node.consequent) && isCxClass(scope, node.alternate);
    default:
      return false;
  }
}

/** A `style` value the lint allows: an object literal of custom properties (`"--name": value`). */
function isCustomProperties(node) {
  return (
    node.type === "ObjectExpression" &&
    node.properties.length > 0 &&
    node.properties.every(
      (p) => p.type === "Property" && p.kind === "init" && !p.computed && p.key.type === "Literal" && typeof p.key.value === "string" && p.key.value.startsWith("--"),
    )
  );
}

const noClassOrStyle = {
  meta: {
    type: "problem",
    docs: { description: "Style elements with stylex.attrs() or StyleX class constants, never hand-written classes or styles" },
    messages: {
      attr: "No `{{name}}` in JSX: spread {...stylex.attrs(…)} instead",
      cls: "`class` takes only a module-level class constant from src/cx.ts (or an entry of one): spread {...stylex.attrs(…)} otherwise",
      style: "`style` sets only CSS custom properties (an object literal of `--name` keys), which static styles read: spread {...stylex.attrs(…)} otherwise",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type === "JSXNamespacedName") {
          const ns = node.name.namespace.name;
          const name = node.name.name.name;
          if (ns === "class" || ns === "style" || ((ns === "prop" || ns === "attr") && /^(?:class|className|classList|style)$/.test(name))) {
            context.report({ node, messageId: "attr", data: { name: `${ns}:${name}` } });
          }
          return;
        }
        const name = node.name.name;
        if (name === "className" || name === "classList") return context.report({ node, messageId: "attr", data: { name } });
        const value = node.value?.type === "JSXExpressionContainer" ? node.value.expression : undefined;
        if (name === "class" && (value === undefined || !isCxClass(context.sourceCode.getScope(node), value))) {
          context.report({ node, messageId: "cls" });
        }
        if (name === "style" && (value === undefined || !isCustomProperties(value))) context.report({ node, messageId: "style" });
      },
    };
  },
};

const oneEscapeStylesheet = {
  meta: {
    type: "problem",
    docs: { description: "The only CSS import is the escape stylesheet" },
    messages: { css: "Import no CSS but ./escape.css (from src/index.tsx): style with StyleX" },
    schema: [],
  },
  create(context) {
    const allowed = (source) =>
      source === "./escape.css" && context.filename.replace(/\\/g, "/").endsWith("/src/index.tsx");
    const check = (node, source) => {
      if (typeof source === "string" && /\.css(?:[?#].*)?$/.test(source) && !allowed(source)) {
        context.report({ node, messageId: "css" });
      }
    };
    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) => node.source.type === "Literal" && check(node, node.source.value),
    };
  },
};

/** For @eslint/css: no colour value of any kind in a stylesheet. */
const noCssColours = {
  meta: {
    type: "problem",
    docs: { description: "No colours in a stylesheet: they come only from the token modules" },
    messages: { colour: "{{what}} in a stylesheet: colours come only from the token modules" },
    schema: [],
  },
  create(context) {
    return {
      Hash(node) {
        context.report({ node, messageId: "colour", data: { what: `#${node.value}` } });
      },
      Function(node) {
        if (COLOUR_FNS.has(node.name.toLowerCase())) {
          context.report({ node, messageId: "colour", data: { what: `${node.name}()` } });
        }
      },
      Identifier(node) {
        if (NAMED.has(node.name.toLowerCase())) {
          context.report({ node, messageId: "colour", data: { what: node.name } });
        }
      },
    };
  },
};

export default {
  meta: { name: "beghu" },
  rules: {
    "no-colour-literals": noColourLiterals,
    "no-class-or-style": noClassOrStyle,
    "one-escape-stylesheet": oneEscapeStylesheet,
    "no-css-colours": noCssColours,
  },
};
