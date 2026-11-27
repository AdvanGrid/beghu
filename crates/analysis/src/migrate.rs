//! The migrations: one step per schema version, `vN → vN+1`, over `serde_json::Value`. The chain
//! ends by deserialising into the current types; old type definitions aren't kept, so a version
//! exists only as the step that leaves it.
//!
//! A step may reshape data, but never edit quoted code or line ranges (evidence `path`, `start`,
//! `end`, `snippet`): a snippet check that passed before a migration stays true after it. A step
//! should avoid renaming IDs, since URLs, colours and `carried` hang on them; one that can't
//! returns each rename, which the server stores as `migratedIds`. Colours derived from a renamed
//! facet or value ID change, which is accepted; such a step says so in its comment.

use serde_json::Value;

/// The current schema version. Bump it with any change to the analysis's shape, in the same
/// change as the step that leaves the old version (the schema guard in `tests/schema.rs` fails
/// otherwise).
pub const VERSION: u32 = 1;

/// A step's work: the file at its version in, the file at the next version and the IDs it renamed
/// out.
pub type StepFn = fn(Value) -> Result<(Value, Vec<Rename>), String>;

/// One step: it takes an analysis at version `from` and returns it at `from + 1`.
pub struct Step {
    pub from: u32,
    pub run: StepFn,
}

/// An ID a step renamed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rename {
    pub old: String,
    pub new: String,
    /// The version the step left.
    pub step: u32,
}

/// The chain, in order. Version 1 is the first production version, so there is no step yet.
pub const STEPS: &[Step] = &[];

/// A chain of steps up to a version. Everything uses [`CHAIN`]; a test can build its own.
pub struct Chain<'a> {
    pub version: u32,
    pub steps: &'a [Step],
}

/// This build's chain.
pub const CHAIN: Chain<'static> = Chain {
    version: VERSION,
    steps: STEPS,
};

/// What migrating a file did.
#[derive(Debug, Clone, PartialEq)]
pub struct Migrated {
    pub value: Value,
    /// The version the file had.
    pub from: u32,
    pub renames: Vec<Rename>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrateError {
    /// `version` is missing or isn't a positive integer (the chain's version is given).
    NoVersion(u32),
    /// Newer than the chain's version.
    Newer(u64, u32),
    /// A step failed: a bug in the step or a file it can't read.
    Step { from: u32, message: String },
}

impl std::fmt::Display for MigrateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrateError::NoVersion(max) => {
                write!(f, "`version` must be a schema version from 1 to {max}")
            }
            MigrateError::Newer(v, max) => write!(
                f,
                "version {v} is newer than this validator's {max}: refetch schema.ts, validate.mjs and the instructions"
            ),
            MigrateError::Step { from, message } => {
                write!(
                    f,
                    "the migration from version {from} to {} failed: {message}",
                    from + 1
                )
            }
        }
    }
}

/// Brings any older file (an analysis, a fragment or a merge's output) up to `VERSION`, leaving
/// a current one as it is.
pub fn migrate_value(value: Value) -> Result<Migrated, MigrateError> {
    CHAIN.migrate(value)
}

impl Chain<'_> {
    /// Runs every step from the file's version up to the chain's.
    pub fn migrate(&self, mut value: Value) -> Result<Migrated, MigrateError> {
        let version = self.version;
        let from = match value.get("version").and_then(Value::as_u64) {
            Some(v) if v >= 1 && v <= u64::from(version) => v as u32,
            Some(v) if v > u64::from(version) => return Err(MigrateError::Newer(v, version)),
            _ => return Err(MigrateError::NoVersion(version)),
        };
        let mut renames = Vec::new();
        for step in self.steps.iter().filter(|s| s.from >= from) {
            let (next, mut r) = (step.run)(value).map_err(|message| MigrateError::Step {
                from: step.from,
                message,
            })?;
            value = next;
            if let Some(obj) = value.as_object_mut() {
                obj.insert("version".into(), Value::from(step.from + 1));
            }
            renames.append(&mut r);
        }
        Ok(Migrated {
            value,
            from,
            renames,
        })
    }
}
