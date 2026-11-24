//! The analysis's shape, version 1. These types are the schema: `cargo test` generates
//! `generated/schema.ts` from them, doc comments included, and the analysis run serves that file
//! to the agent as `schema.ts`. Every doc comment here is part of the agent's instructions, so
//! write them for an agent: what to put in the field, from where, and how short.
//!
//! Field names are camelCase in JSON. Every `claims` field is a list of claim IDs (`c1`, `c2`, …)
//! from the analysis's `claims`. An unknown field is an error, so a typo never passes silently.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

/// One PR analysis: the system at the PR's base and head drawn as one graph, where every element
/// says how the PR changed it; the PR's purposes, read across that graph; the conflicts between
/// what the PR says and what its code does; and the claims that back every statement with
/// evidence.
///
/// Build it from code. The description and the issues the run served are sources for the purpose
/// view only (`purposes`, roles, walks and conflict sides), never for nodes, lines, facets or
/// scenarios.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct Analysis {
    /// The schema version this file follows: the `version` this `schema.ts` was generated for.
    pub version: u32,
    pub pr: Pr,
    /// What the analysis read, skipped and couldn't reach, for the reader.
    pub coverage: Coverage,
    /// The whole PR in one paragraph: what changed, from the code, even when no purpose is backed.
    pub walk: Walk,
    /// Every part, store, external system and person, under one `system` node.
    pub nodes: Vec<Node>,
    /// The lines: one per interaction between two nodes.
    pub edges: Vec<Edge>,
    pub boundaries: Vec<Boundary>,
    /// Flows the PR adds or changes, as ordered steps cut into chapters.
    pub scenarios: Vec<Scenario>,
    /// The dimensions nodes and lines are described by, discovered in this repo.
    pub facets: Vec<Facet>,
    /// What the PR sets out to do, in reading order: top-level purposes first, then each one's
    /// sub-purposes. Empty only when no purpose can be backed (then `unbacked` says why).
    pub purposes: Vec<Purpose>,
    /// Two facts about the PR that don't agree, side by side, with no verdict.
    pub conflicts: Vec<Conflict>,
    /// Causes several conflicts share, each shown with code evidence.
    pub causes: Vec<Cause>,
    /// Every changed leaf part that serves no purpose, with why.
    pub unclaimed: Vec<Unclaimed>,
    /// One or two sentences on why no purpose could be backed. Present exactly when `purposes` is
    /// empty.
    pub unbacked: Option<String>,
    /// Every ID of the previous analysis this one no longer has, and where it went.
    pub carried: Vec<Carried>,
    /// Every statement's backing: the claims the rest of the file points at by ID.
    pub claims: Vec<Claim>,
}

/// The PR, as the run pinned it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pr {
    /// `owner/repo`.
    pub repo: String,
    pub number: u32,
    pub title: String,
    pub url: String,
    /// The author's login.
    pub author: String,
    /// The PR's description, verbatim from `pr.json`. A source for the purpose view only.
    pub description: String,
    /// The merge base you computed with `git merge-base <base tip> <head>`: the commit the PR's
    /// changes are measured from, and the commit every `side: "base"` evidence quotes.
    pub base_sha: String,
    /// The head SHA the run pinned. Every `side: "head"` evidence quotes it.
    pub head_sha: String,
    pub stats: PrStats,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrStats {
    /// Changed files, as `pr.json` counts them.
    pub files: u32,
    pub additions: u32,
    pub deletions: u32,
}

/// Honest coverage: what the analysis covers, what it skipped and what it couldn't reach.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Coverage {
    /// One or two sentences: how much of the change the analysis covers.
    pub summary: String,
    /// Files not read line by line (generated code, lockfiles, fixtures, translations), grouped.
    pub skipped: Vec<Skipped>,
    /// Anything else the reader should know about the analysis's limits, one sentence each. Name
    /// every partly drawn part here ("sandbox: 3 of 9 folders drawn, the ones this PR's flows
    /// reach").
    pub notes: Vec<String>,
    /// Linked references the run didn't serve (`unreached` in `pr.json`), and how you handled
    /// each.
    pub references: Vec<Reference>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Skipped {
    /// The group, in a few words ("generated TypeScript bindings", "lockfiles").
    pub what: String,
    /// Why it wasn't read line by line.
    pub reason: String,
    /// How many changed files the group holds.
    pub files: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reference {
    /// The reference as `pr.json` lists it (`acme/infra#12`, an issue tracker key, a URL).
    #[serde(rename = "ref")]
    #[ts(rename = "ref")]
    pub reference: String,
    pub how: ReferenceHow,
}

/// `own-tools`: you read it with your own tools (`gh`, an MCP server). What you learned may shape
/// how you name and order purposes, but it is never evidence. `unreached`: you couldn't read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ReferenceHow {
    OwnTools,
    Unreached,
}

/// How the PR changed an element: the head graph compared with the base graph.
///
/// For a node, "changed" means its own code changed: `added` if it exists only at head, `removed`
/// if only at base, `modified` if a file the PR changed lies under its paths or a child's, else
/// `unchanged`. People, external systems and stores the PR merely starts using stay `unchanged`:
/// their new or changed lines carry the change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Change {
    Added,
    Modified,
    Removed,
    Unchanged,
}

/// One paragraph of 2–3 sentences, read in order: intro → journey → destination. At least one
/// claim; claims are per walk, not per sentence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Walk {
    /// Where the reader is and what it's for.
    pub intro: String,
    /// How it gets there: the route through the code, at this level.
    pub journey: String,
    /// What it ends in: what is true once it's done.
    pub destination: String,
    pub claims: Vec<String>,
}

/// What a node is.
///
/// `system`: the one root node, the repo's system; every top-level part, store, external system
/// and person hangs directly off it. `service`, `app`, `library`: a top-level deployable or
/// package. `module`: a folder or set of files inside a part, or a top-level part that is neither
/// (infra, CI, docs, `top-level files`). `store`: a database, queue, cache or bucket the code
/// reads or writes. `external`: a system outside the repo the code talks to. `actor`: a person or
/// caller that starts things.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    System,
    Service,
    App,
    Library,
    Module,
    Store,
    External,
    Actor,
}

/// A node: the system, a part of its code, a store, an external system or a person.
///
/// No grouping nodes: every node is code that exists (a real folder, or files, at base or head),
/// or a store, external system or person. Grouping is data (the `inside-*` and `outside-*`
/// facets), never a node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct Node {
    /// Derived from the node's paths, so a later run on the same code lands on the same ID
    /// (`services/advagent-v3/contract` → `svc-advagent-v3.contract`). Reuse the previous
    /// analysis's ID (`previous-ids.json`) wherever the code is the same.
    pub id: String,
    pub kind: NodeKind,
    /// The enclosing node. Absent only on the `system` node; top-level parts, stores, external
    /// systems and people name the `system` node.
    pub parent: Option<String>,
    /// From the code: the package or folder name. A chain of folders with no code of their own
    /// and one child each is one node, named by the joined path (`cmd/server`).
    pub name: String,
    /// The code the node is, as repo paths (folders or files). Required on every node but
    /// `system`, `external` and `actor`; each must exist at base or head.
    pub paths: Vec<String>,
    /// One line: what this is, from the code.
    pub summary: String,
    pub change: Change,
    /// One line: what the PR did to it, which is also the panel's "What it now does". Required
    /// unless `change` is `unchanged`.
    pub change_summary: Option<String>,
    /// What the node does, a few short items, each with claims. A node with children still has
    /// its own responsibilities.
    pub responsibilities: Vec<Responsibility>,
    /// Its value(s) for every facet that applies to nodes, each value with claims. Every
    /// top-level own part has an `inside-*` value; every store and external system has a value
    /// for each `outside-*` facet. Modules inside a part don't carry `inside-*`.
    pub facets: Vec<FacetAssignment>,
    /// The boundary zone it sits in, if one is clear: a `boundaries` ID.
    pub zone: Option<String>,
    /// The drill-down: the fixed questions for its kind (`ANALYSIS.md`), each answered in at most
    /// two sentences of fact.
    pub questions: Vec<Question>,
    /// The PR's changed files under this node, listed only on the deepest node that holds each
    /// file. Every changed file is on exactly one node.
    pub files: Vec<FileChange>,
    /// Set on an unchanged part opened only along a path (a line, a scenario step, a purpose or a
    /// conflict needs a module inside it), so it holds some of its modules, not all. Changed parts
    /// are always complete and never carry it.
    pub drawn: Option<Drawn>,
    /// Its walk. Required on a changed top-level part and on any part that is a purpose's stop;
    /// optional elsewhere.
    pub walk: Option<Walk>,
    /// How it's built: decisions, constraints and assumptions the code shows. Changed parts only;
    /// code evidence only.
    pub built: Option<Vec<Built>>,
}

/// A partly drawn part.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Drawn {
    #[serde(deserialize_with = "only_true")]
    #[ts(type = "true")]
    pub partial: bool,
    /// The part's total folder count at head, so the view can say "3 of 9 folders drawn": every
    /// folder under its paths, at any depth, that holds at least one file git tracks at head
    /// (directly or in a subfolder). Untracked and ignored folders (`node_modules`, build output)
    /// don't count. The validator counts it from the head checkout's `git ls-files`.
    pub folders: u32,
}

fn only_true<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    if bool::deserialize(d)? {
        Ok(true)
    } else {
        Err(serde::de::Error::custom(
            "`partial` is always `true`: leave `drawn` out on a complete part",
        ))
    }
}

/// Something a node does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Responsibility {
    /// Unique within its node. A `call` line names it in `uses`.
    pub id: String,
    /// What it does, in a few words ("sends report emails through Gmail").
    pub text: String,
    pub change: Change,
    pub claims: Vec<String>,
}

/// One question of the drill-down and its answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Question {
    /// One of the fixed questions for the element's type, as `ANALYSIS.md` words it.
    pub question: String,
    /// At most two short sentences of fact. No verdicts, no recommendations.
    pub answer: String,
    pub claims: Vec<String>,
}

/// A changed file, on the deepest node that holds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct FileChange {
    /// The repo path at head (at base for a removed file).
    pub path: String,
    pub status: FileStatus,
    /// Lines added, as `pr.json` counts them.
    pub added: u32,
    /// Lines removed, as `pr.json` counts them.
    pub removed: u32,
    /// Generated, vendored or lock files: listed, not explained, and counted in
    /// `coverage.skipped`.
    pub generated: bool,
    /// One line: what the change in this file does. Required unless `generated`.
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Removed,
    Renamed,
}

/// Something the code shows about how a changed part is built.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Built {
    pub kind: BuiltKind,
    /// One line of fact.
    pub text: String,
    /// Code evidence only.
    pub claims: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum BuiltKind {
    Decision,
    Constraint,
    Assumption,
}

/// A facet: one question every node (or every line) answers from a set of values discovered in
/// this repo, such as "How is effectful code written?" with "Effect" and "plain async/await".
///
/// Grouping facets: 2–3 `outside-*` facets for external systems and stores (the first, "What
/// does it do for this system?", required), and exactly one `inside-*` facet, "What part of the
/// product is it for?", `multi`, on every top-level own part.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Facet {
    /// Kept between runs (`vocabulary.json`): colours derive from facet and value IDs.
    pub id: String,
    pub name: String,
    /// The question the facet answers, for the reader.
    pub question: String,
    pub applies_to: AppliesTo,
    /// Whether one element can hold more than one value.
    pub multi: bool,
    /// At least two, one of them with ID `unknown` for elements the code doesn't settle.
    pub values: Vec<FacetValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum AppliesTo {
    Node,
    Edge,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FacetValue {
    /// Unique within its facet. A kept ID may change its label, prefix and description freely.
    pub id: String,
    pub label: String,
    /// One to four characters shown beside the colour, so colour is never the only cue (`FX`,
    /// `TS`, `Go`, `DI`).
    pub prefix: String,
    pub description: String,
}

/// An element's value(s) for one facet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct FacetAssignment {
    /// A `facets` ID.
    pub facet: String,
    /// One value, or several for a `multi` facet. Each value carries its own claims. The values
    /// are unordered: never mark one as the main one.
    pub values: Vec<AssignedValue>,
    /// The value IDs at base, when the PR changed them.
    pub was: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignedValue {
    /// A value ID of the facet.
    pub value: String,
    /// At least one: the code that shows this value (who imports it, which entry point uses it).
    pub claims: Vec<String>,
}

/// What kind of interaction a line is. `call`: one part uses another's responsibility. `data`: a
/// read or write of stored or passed data. `event`: a message or event published and consumed.
/// Importing is never a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    Call,
    Data,
    Event,
}

/// When the interaction happens. `runtime`: production code at run time. `build`: Dockerfiles,
/// infra that deploys a part, CI, code generation from another part's schema. `test`: tests or
/// dev tooling reaching another part or an external system (a test that calls the code it tests
/// is not a line).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum When {
    Runtime,
    Build,
    Test,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum Mode {
    #[serde(rename = "sync")]
    #[ts(rename = "sync")]
    Sync,
    #[serde(rename = "async")]
    #[ts(rename = "async")]
    Async,
    #[serde(rename = "n/a")]
    #[ts(rename = "n/a")]
    NotApplicable,
}

/// A line: one interaction between two nodes, drawn at the deepest level you can show (module to
/// module, module to external).
///
/// Draw every direct connection at head between top-level parts, changed or not; a transitive
/// one (A → B → C) is not also A → C, and two parts that share a store connect through the
/// store. One `call` line per (caller, callee responsibility): two nodes can have several lines.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct Edge {
    /// Kept between runs (`previous-ids.json`) while the interaction is the same.
    pub id: String,
    /// The caller, writer or publisher: a node ID.
    pub from: String,
    /// The callee, the store or the consumer: a node ID.
    pub to: String,
    pub kind: EdgeKind,
    pub when: When,
    /// The callee's responsibility this line uses: a responsibility ID of `to` or of a node
    /// inside it. Required on `call`. A function the caller uses that no responsibility covers
    /// means the callee's list is incomplete: add a responsibility.
    pub uses: Option<String>,
    /// A few words for the line ("opens MySQL connections").
    pub label: String,
    /// The domain data that crosses the line. Required on `data` and `event`; on `call` only
    /// when domain data crosses ("sends chat prompts, gets completions"), not for plumbing.
    pub data: Option<EdgeData>,
    pub mode: Mode,
    /// `added` when the caller starts using a responsibility, `modified` when the PR changes how
    /// it uses one (with base-side evidence of how it worked before).
    pub change: Change,
    /// The `boundaries` IDs it crosses.
    pub boundaries: Vec<String>,
    /// Its value(s) for every facet that applies to lines.
    pub facets: Vec<FacetAssignment>,
    /// The drill-down: the fixed questions for a line.
    pub questions: Vec<Question>,
    /// At least one claim whose code evidence is the call site on the `from` node's paths (the
    /// lines that call, write or publish); from an external system or a person, the receiving
    /// entry point on the `to` node's paths. A connection you suspect but can't confirm gets an
    /// `undetermined` claim with `lookedAt`.
    pub claims: Vec<String>,
    /// When it happens, in prose ("on every probe start").
    pub occurs: Option<String>,
    /// Its walk. Required on a line that is a purpose's stop; optional elsewhere.
    pub walk: Option<Walk>,
    /// What depends on it: parts or purposes that break without it. Required wherever `walk` is.
    pub needed_by: Option<Vec<NeededBy>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EdgeData {
    /// What crosses, in domain terms: records, messages, files, prompts, model output,
    /// credentials ("probe session rows", "a third-party API's requests"). Never just "data" or
    /// "request".
    pub what: String,
    /// `forward`: from `from` to `to`. `back`: from `to` to `from` (a read). `both`: each way.
    pub direction: Direction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Forward,
    Back,
    Both,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct NeededBy {
    /// One line: what needs it and for what.
    pub text: String,
    /// The node that needs it, if one does.
    pub node: Option<String>,
    /// The purpose that needs it, if one does.
    pub purpose: Option<String>,
}

/// Where trust, process, network or tenant changes: browser ↔ server, service ↔ service, service
/// ↔ third party, user input ↔ trusted code, sandbox ↔ host, tenant data separation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Boundary {
    pub id: String,
    pub kind: BoundaryKind,
    /// What is on each side, in a few words ("browser ↔ API").
    pub name: String,
    pub claims: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum BoundaryKind {
    Trust,
    Process,
    Network,
    Tenant,
}

/// An ordered flow through the graph that the PR adds or changes, from a trigger (a person acts,
/// a schedule, a message, a deploy) to its end.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scenario {
    pub id: String,
    /// A short sentence of fact ("an admin starts a probe").
    pub title: String,
    /// What starts it ("an admin starts a probe from the audit page").
    pub trigger: String,
    /// Every hop, in order, each at the deepest node it happens in (a module, not its service).
    /// No limit on the count: never drop steps to shorten a flow. The view rolls steps up and
    /// folds them.
    pub steps: Vec<Step>,
    /// The flow cut into moments, in order, covering every step. The first starts at step 0.
    pub chapters: Vec<Chapter>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct Step {
    /// A node ID.
    pub from: String,
    /// A node ID.
    pub to: String,
    /// What happens, in a few words.
    pub action: String,
    /// What crosses, in a few words.
    pub data: Option<String>,
    /// The line this step travels, where one exists.
    pub edge: Option<String>,
    pub change: Change,
    pub claims: Vec<String>,
}

/// One moment of a flow. It ends where the flow hands over: a person acts, a part writes
/// something another part picks up later (a queued row, a message), a deploy stage ends. A
/// synchronous request is one chapter even when it crosses services. Usually 2–6 steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chapter {
    /// What happens in it, as a short sentence of fact ("advagent-v3 takes the message and
    /// replies"), never a verdict.
    pub title: String,
    /// The 0-based index of its first step; each chapter runs to the next one's `from`.
    pub from: u32,
}

/// Something the PR sets out to do, from its description, the issues the run served and its
/// code. Purposes cross the code's structure: one purpose can span many parts, and a part can
/// serve several.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct Purpose {
    /// A path-like slug: `purpose:tenant-isolation`, and for a sub-purpose its parent's ID, a
    /// slash and its own slug: `purpose:tenant-isolation/role-check`. Kept between runs
    /// (`vocabulary.json`).
    pub id: String,
    /// In the PR's own terms, from the description, the served issues and the code.
    pub name: String,
    /// The parent purpose's ID, for a sub-purpose. Two levels at most.
    pub parent: Option<String>,
    pub kind: PurposeKind,
    pub walk: Walk,
    /// The journey, in order: sub-purposes, parts at any level and lines, each with one line of
    /// text. A curated subset: a part or line stop is a member (`serves`, `carries`) or contains
    /// one. Every part or line stop has its own `walk`.
    pub stops: Vec<Stop>,
    /// Every part that serves it, at the deepest part that does (never also an ancestor of it),
    /// with its role in this purpose. The part may be unchanged.
    pub serves: Vec<Serves>,
    /// Only the lines its flow passes along, not every line between two members.
    pub carries: Vec<Carries>,
    /// Universal statements this purpose says must hold, each checked against all of head.
    pub rules: Option<Vec<Rule>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PurposeKind {
    Feature,
    Process,
    Security,
    Fix,
    Groundwork,
    Chore,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stop {
    /// A sub-purpose, node or edge ID.
    #[serde(rename = "ref")]
    #[ts(rename = "ref")]
    pub reference: String,
    /// One line: what happens at this stop.
    pub line: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Serves {
    /// A node ID: the deepest part that serves the purpose.
    pub node: String,
    /// One line: what this part does for the purpose.
    pub role: String,
    pub claims: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Carries {
    /// An edge ID.
    pub edge: String,
    /// One line: why the purpose's flow passes along it.
    pub why: String,
    pub claims: Vec<String>,
}

/// A universal statement a purpose says must hold, stated in the description or a served issue,
/// or established by the PR's own code, checked against all of head (not just the diff).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    /// Unique across the analysis. A purpose-outside conflict names it.
    pub id: String,
    /// The rule, as a statement ("every handler checks the caller's role").
    pub text: String,
    /// Where it applies, in plain words ("HTTP handlers under `services/<name>/api`").
    pub scope: String,
    /// Claim IDs: where the rule is stated or established.
    pub sources: Vec<String>,
    pub checked: RuleCheck,
}

/// The rule's check: the scope as written, enumerated with search, each site followed one hop
/// (the site and what it directly calls). A site you can't decide is undetermined, never a break.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleCheck {
    /// How you looked: patterns, globs, entry points, route tables.
    pub searched: String,
    /// Sites found.
    pub found: u32,
    pub holds: u32,
    pub breaks: u32,
    pub undetermined: u32,
}

/// Two facts about the PR that don't agree, side by side, with no verdict.
///
/// `stated-code`: the description or an issue against the code (a stated promise no code serves
/// is one, with an `undetermined` code side). `purpose-purpose`: two purposes against each other,
/// found by comparing what each purpose's role needs from every part that serves two or more.
/// `purpose-outside`: a purpose's rule against code outside the diff; one conflict per broken
/// rule, never one per site.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct Conflict {
    /// Stable within this analysis only: conflicts don't carry between runs.
    pub id: String,
    pub kind: ConflictKind,
    /// The question both sides answer, in a few words, with no verdict ("Are refunds retried?").
    pub question: String,
    /// A `causes` ID, when the conflict shares a cause with others.
    pub cause: Option<String>,
    pub a: Side,
    pub b: Side,
    /// `purpose-outside` only: the ID of the rule it breaks.
    pub rule: Option<String>,
    /// What it touches. `nodes` includes every node the sides' code evidence lands in, unchanged
    /// ones included.
    pub touches: Touches,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictKind {
    StatedCode,
    PurposePurpose,
    PurposeOutside,
}

/// One side of a conflict: a fact and where it comes from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct Side {
    pub who: Who,
    /// The purpose speaking, when `who` is `purpose`.
    pub purpose: Option<String>,
    /// The answer in a few words, shown on the card ("retried 3 times", "not retried").
    pub says: String,
    /// The whole fact, shown when the row opens.
    pub text: String,
    pub claims: Vec<String>,
    /// `purpose-outside`, the outside side: the first 20 break sites, each a claim with code
    /// evidence, then how many more the search found.
    pub sites: Option<Sites>,
}

/// `description` and `issue`: what the PR says. `code`: what the PR's code does. `purpose`: what
/// a purpose needs. `outside`: code outside the diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Who {
    Description,
    Issue,
    Code,
    Outside,
    Purpose,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sites {
    /// At most 20.
    pub claims: Vec<String>,
    /// Breaks found beyond those listed.
    pub more: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Touches {
    pub purposes: Vec<String>,
    pub nodes: Vec<String>,
    pub edges: Vec<String>,
}

/// A cause several conflicts share ("Migrations were renumbered after the description was
/// written"). Write one only when code evidence shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cause {
    pub id: String,
    pub text: String,
    /// Code evidence only.
    pub claims: Vec<String>,
}

/// A changed leaf part that serves no purpose.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Unclaimed {
    /// A node ID.
    pub node: String,
    /// One line: why it serves no purpose.
    pub reason: String,
}

/// A previous analysis's ID this analysis no longer has, and where it went. Covers node, edge,
/// facet, facet value (`<facet id>/<value id>`) and purpose IDs. Conflicts, causes, scenarios and
/// chapters don't carry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Carried {
    pub kind: CarriedKind,
    /// The previous ID.
    pub was: String,
    /// The IDs it became: one for `renamed` and `merged`, two or more for `split`, none for
    /// `dropped`.
    pub now: Vec<String>,
    pub cause: CarriedCause,
    /// One line: what happened to it.
    pub reason: String,
    /// At least one claim with code evidence: the lines that show the new reading. "The previous
    /// run was weaker" isn't evidence.
    pub claims: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum CarriedKind {
    Renamed,
    Merged,
    Split,
    Dropped,
}

/// `code`: the code moved, renamed or removed the thing. `correction`: the previous analysis was
/// wrong. `scope`: this run no longer needs to draw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum CarriedCause {
    Code,
    Correction,
    Scope,
}

/// A statement of fact and the evidence that shows it. Reuse a claim wherever it backs several
/// statements.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct Claim {
    /// `c1`, `c2`, …
    pub id: String,
    /// Specific: "`Run` releases the lease and requeues the row after `d`", not "handles
    /// waiting".
    pub text: String,
    pub status: ClaimStatus,
    /// At least one item when `supported`. The code view (nodes, lines, facets, responsibilities,
    /// questions, scenarios, `built`, `carried`, causes, break sites) needs code evidence; only
    /// claims behind purposes, roles, walks and conflict sides may rest on the description or an
    /// issue alone.
    pub evidence: Vec<Evidence>,
    /// Where you looked, when `undetermined`.
    pub looked_at: Option<String>,
}

/// `supported`: the evidence shows it. `undetermined`: you couldn't tell; `lookedAt` says where
/// you looked. Never guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ClaimStatus {
    Supported,
    Undetermined,
}

/// What shows a claim: exact code lines, or a verbatim quote of the PR's description or an issue
/// the run served.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
#[ts(tag = "kind", rename_all = "lowercase")]
pub enum Evidence {
    Code {
        /// `head` for code as it is after the PR, `base` for code as it was (at the merge base).
        side: CodeSide,
        /// Repo-relative.
        path: String,
        /// 1-based, inclusive. At most 25 lines: trim the range, not the text.
        start: u32,
        end: u32,
        /// What these lines show.
        note: String,
        /// The exact text of lines `start`..`end`, copied from the file.
        snippet: String,
    },
    Description {
        /// Word for word from `pr.json`'s description.
        quote: String,
        note: String,
    },
    Issue {
        /// `owner/repo` of an issue the run served in `pr.json`. Never an issue it didn't serve.
        repo: String,
        number: u32,
        /// Word for word from the issue's body or a comment, as `pr.json` serves it.
        quote: String,
        note: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum CodeSide {
    Base,
    Head,
}
