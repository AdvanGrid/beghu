//! The raw-HTML allowlist, modelled on GitHub's: html-pipeline's `SanitizationFilter`, the public
//! descendant of what github.com runs (docs/research/markdown-rendering.md, §2), plus what
//! comrak's own output needs (task-list checkboxes, alerts, footnotes, `language-*`) and what
//! GitHub keeps beyond the filter (`picture`/`source`).
//!
//! Everything else goes: `script`, `style` and the embedding tags with their content, `on*`
//! handlers, `style` and other `class`es, and any URL whose scheme isn't http(s) or mailto.
//! Relative URLs pass through, for the AST pass to resolve against GitHub.

use ammonia::{Builder, UrlRelative};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// Elements kept, children and all.
const TAGS: &[&str] = &[
    "a",
    "abbr",
    "b",
    "bdo",
    "blockquote",
    "br",
    "caption",
    "cite",
    "code",
    "dd",
    "del",
    "details",
    "dfn",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "input",
    "ins",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "picture",
    "pre",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "section",
    "small",
    "source",
    "span",
    "strike",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "time",
    "tr",
    "tt",
    "ul",
    "var",
    "wbr",
];

/// Elements dropped with everything inside them. Any other element not in [`TAGS`] is dropped
/// but its children stay.
const DROPPED_WHOLE: &[&str] = &[
    "embed", "frame", "frameset", "iframe", "noembed", "noframes", "noscript", "object", "script",
    "style", "template", "textarea", "title",
];

/// Attributes any kept element may have.
const GENERIC: &[&str] = &["dir", "id", "lang", "title"];

/// Attributes per element, on top of [`GENERIC`].
const PER_TAG: &[(&str, &[&str])] = &[
    (
        "a",
        &[
            "aria-label",
            "class",
            "data-footnote-backref",
            "data-footnote-ref",
            "href",
            "name",
        ],
    ),
    ("blockquote", &["cite"]),
    ("code", &["class"]),
    ("del", &["cite"]),
    ("details", &["open"]),
    ("div", &["align", "class"]),
    ("h1", &["align"]),
    ("h2", &["align"]),
    ("h3", &["align"]),
    ("h4", &["align"]),
    ("h5", &["align"]),
    ("h6", &["align"]),
    ("img", &["align", "alt", "height", "src", "width"]),
    ("input", &["checked", "disabled", "type"]),
    ("ins", &["cite"]),
    ("ol", &["start", "type"]),
    ("p", &["align", "class"]),
    ("q", &["cite"]),
    ("section", &["class", "data-footnotes"]),
    ("source", &["height", "media", "srcset", "type", "width"]),
    ("sup", &["class"]),
    ("td", &["align", "colspan", "rowspan"]),
    ("th", &["align", "colspan", "rowspan"]),
    ("time", &["datetime"]),
];

/// URL schemes kept in `href`, `src`, `srcset` and `cite`.
const SCHEMES: &[&str] = &["http", "https", "mailto"];

const ALERTS: &[&str] = &["note", "tip", "important", "warning", "caution"];

/// Whether `class` token `c` means something on `tag`: the classes comrak's output carries.
fn kept_class(tag: &str, c: &str) -> bool {
    match tag {
        "code" => c.strip_prefix("language-").is_some_and(|l| {
            !l.is_empty()
                && l.chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || "_+#.-".contains(ch))
        }),
        "div" => {
            c == "markdown-alert"
                || c.strip_prefix("markdown-alert-")
                    .is_some_and(|k| ALERTS.contains(&k))
        }
        "p" => c == "markdown-alert-title",
        "section" => c == "footnotes",
        "sup" => c == "footnote-ref",
        "a" => c == "footnote-backref",
        _ => false,
    }
}

/// A size as GitHub keeps it: a number of pixels or a percentage.
fn is_size(v: &str) -> bool {
    let n = v.strip_suffix('%').or(v.strip_suffix("px")).unwrap_or(v);
    !n.is_empty() && n.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Narrows the values of the attributes that are allowed: `None` drops the attribute.
fn filter<'u>(tag: &str, attr: &str, value: &'u str) -> Option<Cow<'u, str>> {
    match attr {
        "class" => {
            let kept: Vec<&str> = value
                .split_ascii_whitespace()
                .filter(|c| kept_class(tag, c))
                .collect();
            (!kept.is_empty()).then(|| Cow::Owned(kept.join(" ")))
        }
        // Only a checkbox: a task-list item's, read-only in the browser.
        "type" if tag == "input" => value
            .eq_ignore_ascii_case("checkbox")
            .then_some(value.into()),
        "width" | "height" => is_size(value).then_some(value.into()),
        "align" => {
            let v = value.to_ascii_lowercase();
            [
                "left", "right", "center", "justify", "top", "middle", "bottom",
            ]
            .contains(&v.as_str())
            .then_some(Cow::Owned(v))
        }
        "colspan" | "rowspan" | "start" => value.parse::<u32>().is_ok().then_some(value.into()),
        _ => Some(value.into()),
    }
}

static SANITISER: LazyLock<Builder<'static>> = LazyLock::new(|| {
    let mut b = Builder::empty();
    b.tags(TAGS.iter().copied().collect())
        .clean_content_tags(DROPPED_WHOLE.iter().copied().collect())
        .generic_attributes(GENERIC.iter().copied().collect())
        .tag_attributes(
            PER_TAG
                .iter()
                .map(|(t, a)| (*t, a.iter().copied().collect::<HashSet<_>>()))
                .collect::<HashMap<_, _>>(),
        )
        .url_schemes(SCHEMES.iter().copied().collect())
        .url_relative(UrlRelative::PassThrough)
        .link_rel(None)
        .strip_comments(true)
        .attribute_filter(filter);
    b
});

/// `html` with everything outside the allowlist removed, serialised.
pub(crate) fn clean(html: &str) -> String {
    SANITISER.clean(html).to_string()
}
