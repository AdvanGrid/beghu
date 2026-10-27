// beghu's own lint rules for the web app (see eslint.config.js):
//
// - no-colour-literals: colours come only from the token modules (src/tokens.stylex.ts, and
//   src/md/tokens.stylex.ts for posts' Markdown and code highlighting). Flags a
//   colour function (rgb(), oklch(), light-dark(), …) in any string, a string that is a hex
//   colour, and inside StyleX calls any hex, named or system colour.
// - no-class-or-style: no `class`, `className`, `classList` or `style` attribute in JSX; elements
//   take `{...stylex.attrs(…)}`.
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
      const strict = inStylexCall(context.sourceCode.getAncestors(node));
      const what = colourIn(text, strict);
      if (what) context.report({ node, messageId: "colour", data: { what: what[0].toUpperCase() + what.slice(1) } });
    };
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
    };
  },
};

const noClassOrStyle = {
  meta: {
    type: "problem",
    docs: { description: "Style elements with stylex.attrs(), never class or style" },
    messages: { attr: "No `{{name}}` in JSX: spread {...stylex.attrs(…)} instead" },
    schema: [],
  },
  create(context) {
    return {
      JSXAttribute(node) {
        const name = node.name.type === "JSXIdentifier" ? node.name.name : null;
        if (name === "class" || name === "className" || name === "classList" || name === "style") {
          context.report({ node, messageId: "attr", data: { name } });
        }
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
