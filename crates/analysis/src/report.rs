//! The one report format every tool writes: the server, the beghu CLI, `validate.mjs` and
//! `merge.mjs`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What the validator, the split check or the merge found. Errors refuse the file; warnings
/// don't, but fix them (judging words have false positives, such as a quoted identifier).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    pub errors: Vec<Finding>,
    pub warnings: Vec<Finding>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Finding {
    /// A JSON pointer into the checked file (`/nodes/3/responsibilities/0/claims`), or `""` for
    /// the whole file.
    pub path: String,
    /// The rule's fixed ID (`line.uses`, `claim.stated-only`); `ANALYSIS.md` lists them all.
    pub rule: String,
    pub message: String,
}

impl Report {
    pub fn error(&mut self, path: impl Into<String>, rule: &str, message: impl Into<String>) {
        self.errors.push(Finding {
            path: path.into(),
            rule: rule.to_owned(),
            message: message.into(),
        });
    }

    pub fn warn(&mut self, path: impl Into<String>, rule: &str, message: impl Into<String>) {
        self.warnings.push(Finding {
            path: path.into(),
            rule: rule.to_owned(),
            message: message.into(),
        });
    }

    pub fn is_ok(&self) -> bool {
        self.errors.is_empty()
    }

    /// Every rule ID the report names, errors and warnings alike.
    pub fn rules(&self) -> impl Iterator<Item = &str> {
        self.errors
            .iter()
            .chain(&self.warnings)
            .map(|f| f.rule.as_str())
    }

    pub(crate) fn extend(&mut self, other: Report) {
        self.errors.extend(other.errors);
        self.warnings.extend(other.warnings);
    }
}

/// The rule IDs. Each is fixed once shipped: tools and agents match on them. `ANALYSIS.md`'s
/// "The validator's rules" lists them with what they mean; keep the two in step.
pub mod rule {
    // Versions and shape.
    pub const VERSION_UNKNOWN: &str = "version.unknown";
    pub const SCHEMA_MIGRATED: &str = "schema.migrated";
    pub const MIGRATION_FAILED: &str = "migration.failed";
    pub const SHAPE_JSON: &str = "shape.json";
    pub const SHAPE_MISSING_FIELD: &str = "shape.missing-field";
    pub const SHAPE_UNKNOWN_FIELD: &str = "shape.unknown-field";
    pub const SHAPE_ENUM: &str = "shape.enum";
    pub const SHAPE_TYPE: &str = "shape.type";
    pub const SHAPE_HINTS: &str = "shape.hints";

    // IDs and references.
    pub const ID_DUPLICATE: &str = "id.duplicate";
    pub const REF_UNKNOWN: &str = "ref.unknown";
    pub const CLAIM_ID: &str = "claim.id";
    pub const PURPOSE_ID: &str = "purpose.id";

    // The graph.
    pub const SYSTEM_ROOT: &str = "system.root";
    pub const NODE_PARENT_CYCLE: &str = "node.parent-cycle";
    pub const NODE_PATHS: &str = "node.paths";
    pub const NODE_CHANGE_SUMMARY: &str = "node.change-summary";
    pub const CHANGE_OWN_CODE: &str = "change.own-code";
    pub const FILE_DUPLICATE: &str = "file.duplicate";
    pub const FILE_UNPLACED: &str = "file.unplaced";
    pub const FILE_SUMMARY: &str = "file.summary";
    pub const RESPONSIBILITY_DUPLICATE: &str = "responsibility.duplicate";
    pub const GROUP_RESPONSIBILITY: &str = "group.responsibility";
    pub const GROUP_TOP_LEVEL_KINDS: &str = "group.top-level-kinds";
    pub const GROUP_INSIDE: &str = "group.inside";
    pub const GROUP_OUTSIDE: &str = "group.outside";
    pub const DRAWN_CHANGED: &str = "drawn.changed";
    pub const BUILT_CHANGED: &str = "built.changed";

    // Facets.
    pub const FACET_VALUES: &str = "facet.values";
    pub const FACET_UNKNOWN_VALUE: &str = "facet.unknown-value";
    pub const FACET_PREFIX: &str = "facet.prefix";
    pub const FACET_APPLIES_TO: &str = "facet.applies-to";
    pub const FACET_SINGLE: &str = "facet.single";
    pub const FACET_VALUE_CLAIMS: &str = "facet.value-claims";

    // Lines.
    pub const LINE_USES: &str = "line.uses";
    pub const LINE_DATA: &str = "line.data";
    pub const LINE_DATA_GENERIC: &str = "line.data-generic";
    pub const LINE_CALL_SITE: &str = "line.call-site";
    pub const LINE_PER_INTERACTION: &str = "line.per-interaction";
    pub const LINE_NEEDED_BY: &str = "line.needed-by";

    // Scenarios.
    pub const CHAPTER_MISSING: &str = "chapter.missing";
    pub const CHAPTER_FIRST: &str = "chapter.first";
    pub const CHAPTER_ORDER: &str = "chapter.order";
    pub const CHAPTER_LONG: &str = "chapter.long";

    // Claims and evidence.
    pub const CLAIMS_MISSING: &str = "claims.missing";
    pub const CLAIM_UNUSED: &str = "claim.unused";
    pub const CLAIM_NO_EVIDENCE: &str = "claim.no-evidence";
    pub const CLAIM_LOOKED_AT: &str = "claim.looked-at";
    pub const CLAIM_STATED_ONLY: &str = "claim.stated-only";
    pub const EVIDENCE_LINES: &str = "evidence.lines";
    pub const WORDS_JUDGING: &str = "words.judging";

    // Purposes and conflicts.
    pub const PURPOSE_DEPTH: &str = "purpose.depth";
    pub const PURPOSE_REDUNDANT_MEMBER: &str = "purpose.redundant-member";
    pub const PURPOSE_NO_MEMBERS: &str = "purpose.no-members";
    pub const PURPOSE_STOP_NOT_MEMBER: &str = "purpose.stop-not-member";
    pub const WALK_REQUIRED: &str = "walk.required";
    pub const WALK_CLAIMS: &str = "walk.claims";
    pub const CONFLICT_KIND_SIDES: &str = "conflict.kind-sides";
    pub const CONFLICT_TOUCHES: &str = "conflict.touches";
    pub const CONFLICT_SITES: &str = "conflict.sites";
    pub const CAUSE_EVIDENCE: &str = "cause.evidence";
    pub const UNCLAIMED_MISSING: &str = "unclaimed.missing";
    pub const UNBACKED_EXACT: &str = "unbacked.exact";

    // Carrying over from the previous analysis.
    pub const CARRY_UNACCOUNTED: &str = "carry.unaccounted";
    pub const CARRY_UNKNOWN: &str = "carry.unknown";
    pub const CARRY_PRESENT: &str = "carry.present";
    pub const CARRY_NOW: &str = "carry.now";
    pub const CARRY_EVIDENCE: &str = "carry.evidence";

    // The split procedure.
    pub const HINT_UNRESOLVED: &str = "hint.unresolved";
    pub const SPLIT_FILE_AREA: &str = "split.file-area";
    pub const SPLIT_PART_AREA: &str = "split.part-area";
    pub const SPLIT_OVERLAP: &str = "split.overlap";
    pub const SPLIT_ID: &str = "split.id";
    pub const SPLIT_SYSTEM_AREA: &str = "split.system-area";
    pub const MERGE_DUPLICATE: &str = "merge.duplicate";

    // With a reader over the two checkouts.
    pub const EVIDENCE_FILE: &str = "evidence.file";
    pub const EVIDENCE_RANGE: &str = "evidence.range";
    pub const EVIDENCE_SNIPPET: &str = "evidence.snippet";
    pub const PATH_MISSING: &str = "path.missing";
    pub const DRAWN_FOLDERS: &str = "drawn.folders";

    /// Every rule ID the crate reports, for the instructions' list and the one-test-per-rule
    /// check.
    pub const ALL: &[&str] = &[
        VERSION_UNKNOWN,
        SCHEMA_MIGRATED,
        MIGRATION_FAILED,
        SHAPE_JSON,
        SHAPE_MISSING_FIELD,
        SHAPE_UNKNOWN_FIELD,
        SHAPE_ENUM,
        SHAPE_TYPE,
        SHAPE_HINTS,
        ID_DUPLICATE,
        REF_UNKNOWN,
        CLAIM_ID,
        PURPOSE_ID,
        SYSTEM_ROOT,
        NODE_PARENT_CYCLE,
        NODE_PATHS,
        NODE_CHANGE_SUMMARY,
        CHANGE_OWN_CODE,
        FILE_DUPLICATE,
        FILE_UNPLACED,
        FILE_SUMMARY,
        RESPONSIBILITY_DUPLICATE,
        GROUP_RESPONSIBILITY,
        GROUP_TOP_LEVEL_KINDS,
        GROUP_INSIDE,
        GROUP_OUTSIDE,
        DRAWN_CHANGED,
        BUILT_CHANGED,
        FACET_VALUES,
        FACET_UNKNOWN_VALUE,
        FACET_PREFIX,
        FACET_APPLIES_TO,
        FACET_SINGLE,
        FACET_VALUE_CLAIMS,
        LINE_USES,
        LINE_DATA,
        LINE_DATA_GENERIC,
        LINE_CALL_SITE,
        LINE_PER_INTERACTION,
        LINE_NEEDED_BY,
        CHAPTER_MISSING,
        CHAPTER_FIRST,
        CHAPTER_ORDER,
        CHAPTER_LONG,
        CLAIMS_MISSING,
        CLAIM_UNUSED,
        CLAIM_NO_EVIDENCE,
        CLAIM_LOOKED_AT,
        CLAIM_STATED_ONLY,
        EVIDENCE_LINES,
        WORDS_JUDGING,
        PURPOSE_DEPTH,
        PURPOSE_REDUNDANT_MEMBER,
        PURPOSE_NO_MEMBERS,
        PURPOSE_STOP_NOT_MEMBER,
        WALK_REQUIRED,
        WALK_CLAIMS,
        CONFLICT_KIND_SIDES,
        CONFLICT_TOUCHES,
        CONFLICT_SITES,
        CAUSE_EVIDENCE,
        UNCLAIMED_MISSING,
        UNBACKED_EXACT,
        CARRY_UNACCOUNTED,
        CARRY_UNKNOWN,
        CARRY_PRESENT,
        CARRY_NOW,
        CARRY_EVIDENCE,
        HINT_UNRESOLVED,
        SPLIT_FILE_AREA,
        SPLIT_PART_AREA,
        SPLIT_OVERLAP,
        SPLIT_ID,
        SPLIT_SYSTEM_AREA,
        MERGE_DUPLICATE,
        EVIDENCE_FILE,
        EVIDENCE_RANGE,
        EVIDENCE_SNIPPET,
        PATH_MISSING,
        DRAWN_FOLDERS,
    ];
}
