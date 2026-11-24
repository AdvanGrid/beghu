//! The shapes the split procedure's tools read and write (`split.json`, a fragment's `hints`),
//! the previous analysis's skeleton the run serves (`previous-ids.json`, `vocabulary.json`) and
//! the validator's report. They're generated into `schema.ts` with the analysis's own types.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::schema::{AppliesTo, EdgeKind, FacetValue, PurposeKind};

/// `split.json`: the skeleton's plan for a split run, written before any area starts and checked
/// by the split check (`node validate.mjs <skeleton> <base> <head> --split split.json`, or
/// `beghu analyse check-split`). Only a split run writes one: in single mode one agent does every
/// step, and there is no `split.json` and no split check. `node merge.mjs --split split.json`
/// reads its candidates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Split {
    /// `split`: areas run as separate agents. A single-mode run writes no `split.json`, so this
    /// is `split` in every file the tools read.
    pub mode: SplitMode,
    /// Disjoint slices of the repo, drawn from its own structure (workspaces, services,
    /// packages), not from the diff alone. Every changed file is owned by exactly one area, and
    /// every top-level part lies in exactly one area.
    pub areas: Vec<Area>,
    /// Pairs of top-level parts where one might use the other, found from imports, manifest
    /// dependencies, client construction and URLs in config. The caller's area must draw each as
    /// lines or reject it with a claim, in a `candidate` hint; `merge.mjs --split` turns each one
    /// no fragment resolved into an unresolved `candidate` hint for the seam pass.
    pub candidates: Vec<Candidate>,
    /// The PR's purposes, in reading order, settled before the areas run.
    pub purposes: Vec<SplitPurpose>,
    /// The rules to check against all of head, one check each after the merge.
    pub rules: Vec<SplitRule>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum SplitMode {
    Single,
    Split,
}

/// One agent's share of the run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Area {
    /// Derived from its paths: one of its `prefixes`, without the trailing slash.
    pub id: String,
    /// The repo path prefixes it covers (`services/api/`): repo-relative folders, never the repo
    /// root (`""`, `.`, `./`, `/`). No prefix lies inside another area's.
    pub prefixes: Vec<String>,
    /// The changed files it owns, as `pr.json` lists them, each under one of its prefixes.
    pub owns: Vec<String>,
    /// The top-level parts (node IDs) it needs to read beyond its own, such as the libraries its
    /// code calls.
    pub reads: Vec<String>,
    /// How much reading it holds, in words, for the checkpoint ("70 files, 129 fixtures counted
    /// cheap").
    pub estimate: String,
    /// A system area: unchanged parts no changed area covers. It draws their lines and
    /// responsibilities only, and owns no changed file.
    pub system: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    /// The top-level part that might use `to`: its area owns the candidate.
    pub from: String,
    pub to: String,
    /// What suggested it ("imports `golib/db`", "`ESG_URL` in its config").
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SplitPurpose {
    /// The purpose's ID, as in the analysis (`purpose:tenant-isolation`).
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
    pub kind: PurposeKind,
    /// Where it's stated, in words: "description", an issue as `owner/repo#N`, or "code" with the
    /// path that shows it.
    pub sources: Vec<String>,
    pub flow: Flow,
}

/// A purpose's flow sketch, for the seam pass to trace across the merged graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Flow {
    /// Where the flow starts: routes, handlers, jobs, commands, as paths or symbols.
    pub entries: Vec<String>,
    /// The rough path through top-level parts (node IDs), in order.
    pub path: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitRule {
    /// The purpose that sets the rule.
    pub purpose: String,
    pub id: String,
    pub text: String,
    pub scope: String,
    /// Where it's stated, as in `SplitPurpose.sources`.
    pub sources: Vec<String>,
}

/// Something an area or the merge leaves for the seam pass. Hints live in fragments and in the
/// merge's output, never in the upload: the seam pass resolves every one, then
/// `node merge.mjs --finish` strips them.
///
/// - `seam`: a line the area expects to cross into another area; it knows the caller, not the
///   callee's module. The merge drops it when a line of its `lineKind` (and its `uses`, when
///   given) runs from inside `from` to inside `to`. Resolve the rest `drawn` or `rejected`.
/// - `deepen` (written by the merge): a line from one area ends at a part that has children in
///   another area. Resolve it `deepened` (to the child it reaches) or `rejected`.
/// - `candidate`: a `split.json` candidate this area owns, resolved by the area itself: `drawn`
///   (the line IDs in `refs`) or `rejected` with a claim ("imports only shared types").
/// - `purpose`: a purpose the area's code serves that `split.json` doesn't name. An area can't
///   create a purpose: it hints one, and the merge turns a purpose an area writes that neither
///   the skeleton nor `split.json` has into this hint. Resolve it `added`, `folded` or `rejected`.
/// - `rule`: a rule the area's code establishes or breaks that `split.json` doesn't name (the
///   merge turns one an area writes anyway into this hint too). Resolve it `added`, `folded` or
///   `rejected`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
#[ts(tag = "kind", rename_all = "lowercase")]
pub enum Hint {
    Seam {
        /// The caller: a node ID in this area.
        from: String,
        /// The deepest node it knows in the other area (often a top-level part).
        to: String,
        #[serde(rename = "lineKind")]
        #[ts(rename = "lineKind")]
        line_kind: EdgeKind,
        /// For a `call`, the callee's responsibility ID it expects to use, when the area knows it.
        /// Given, only a line with this `uses` answers the hint; omitted, any line of `lineKind`
        /// between the two does.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        uses: Option<String>,
        /// What the caller uses or sends, in a few words.
        why: String,
        claims: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        resolution: Option<Resolution>,
    },
    Deepen {
        /// The edge ID.
        line: String,
        /// The node it ends at.
        to: String,
        /// That node's children, drawn by another area.
        children: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        resolution: Option<Resolution>,
    },
    Candidate {
        from: String,
        to: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        resolution: Option<Resolution>,
    },
    Purpose {
        name: String,
        /// The purpose it would sit under, if any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        parent: Option<String>,
        /// The node IDs that serve it.
        nodes: Vec<String>,
        why: String,
        claims: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        resolution: Option<Resolution>,
    },
    Rule {
        /// The purpose it belongs to.
        purpose: String,
        text: String,
        scope: String,
        claims: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        resolution: Option<Resolution>,
    },
}

/// How the seam pass (or, for a candidate, the area) resolved a hint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resolution {
    pub how: ResolutionHow,
    /// What it became: edge IDs for `drawn` and `deepened`, a purpose ID for `added` and
    /// `folded` (a rule ID for a rule hint). Empty for `rejected`.
    pub refs: Vec<String>,
    /// For `rejected`, at least one claim saying where you looked.
    pub claims: Vec<String>,
}

/// `drawn`: the line now exists. `deepened`: the line now ends at the child it reaches. `added`:
/// a purpose, sub-purpose or rule now holds it. `folded`: an existing purpose or rule took it in.
/// `rejected`: it doesn't hold, and a claim says why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ResolutionHow {
    Drawn,
    Deepened,
    Added,
    Folded,
    Rejected,
}

/// `previous-ids.json`: the previous analysis's node and line IDs, nothing else. Reuse them where
/// the code is the same; every one this analysis drops goes in `carried`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviousIds {
    pub nodes: Vec<PreviousNode>,
    pub edges: Vec<PreviousEdge>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviousNode {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviousEdge {
    pub id: String,
    pub from: String,
    pub to: String,
}

/// `vocabulary.json`: the previous analysis's facets and purposes, with no assignments. Reuse
/// the values that fit and declare the ones you retire or rename in `carried`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Vocabulary {
    pub facets: Vec<VocabularyFacet>,
    pub purposes: Vec<VocabularyPurpose>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VocabularyFacet {
    pub id: String,
    pub name: String,
    pub question: String,
    pub applies_to: AppliesTo,
    pub multi: bool,
    pub values: Vec<FacetValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct VocabularyPurpose {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
}

impl PreviousIds {
    /// The skeleton of a stored analysis, as the run serves it.
    pub fn of(a: &crate::Analysis) -> Self {
        PreviousIds {
            nodes: a
                .nodes
                .iter()
                .map(|n| PreviousNode { id: n.id.clone() })
                .collect(),
            edges: a
                .edges
                .iter()
                .map(|e| PreviousEdge {
                    id: e.id.clone(),
                    from: e.from.clone(),
                    to: e.to.clone(),
                })
                .collect(),
        }
    }
}

impl Vocabulary {
    /// The vocabulary of a stored analysis, as the run serves it.
    pub fn of(a: &crate::Analysis) -> Self {
        Vocabulary {
            facets: a
                .facets
                .iter()
                .map(|f| VocabularyFacet {
                    id: f.id.clone(),
                    name: f.name.clone(),
                    question: f.question.clone(),
                    applies_to: f.applies_to,
                    multi: f.multi,
                    values: f.values.clone(),
                })
                .collect(),
            purposes: a
                .purposes
                .iter()
                .map(|p| VocabularyPurpose {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    parent: p.parent.clone(),
                })
                .collect(),
        }
    }
}
