//! What a run found: each answer checked against its template as it comes in, and kept as a
//! sample for recording templates again.

use crate::http::Answer;
use crate::shape::Difference;
use crate::templates::{Mismatch, Templates};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// What the answers come from, which decides what counts as drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Real GitHub: a template's field GitHub doesn't send, or sends as another kind, is drift.
    /// Fields GitHub sends that the template doesn't hold are new, and don't matter to the fake.
    GitHub,
    /// Fake GitHub: a field the fake sends that the template doesn't hold (the fake inventing),
    /// or sends as another kind, is drift. Template fields the fake leaves out are fine: it
    /// serves what beghu reads, not all GitHub sends.
    Fake,
}

/// One answer that differs from its template.
#[derive(Debug, Clone, PartialEq)]
pub struct Drift {
    pub template: String,
    pub request: String,
    pub what: String,
}

/// Everything a run found.
#[derive(Debug, Default)]
pub struct Findings {
    pub drift: Vec<Drift>,
    /// Facts worth a look that aren't drift: answers no template holds, unknown event types, and
    /// the "record which it is" checks.
    pub notes: Vec<String>,
    /// The templates checked.
    pub checked: BTreeSet<String>,
    /// Each answer by template name: its request, status and body, for recording.
    pub samples: BTreeMap<String, Vec<(String, u16, Value)>>,
    /// Webhook events and actions seen in the App's deliveries, with when each last arrived.
    pub seen: BTreeMap<String, String>,
    /// What the write run left different from how it found it.
    pub left_changed: Vec<String>,
}

#[derive(Debug)]
pub struct Checker {
    pub templates: Templates,
    pub mode: Mode,
    pub found: Findings,
    /// The answers are for recording templates again: runs gather more samples.
    pub recording: bool,
}

impl Checker {
    pub fn new(templates: Templates, mode: Mode) -> Checker {
        Checker {
            templates,
            mode,
            found: Findings::default(),
            recording: false,
        }
    }

    /// Checks `status` and `body` against template `name`, for `request` (`GET /repos/…`).
    pub fn body(&mut self, name: &str, request: &str, status: u16, body: &Value) {
        self.found
            .samples
            .entry(name.to_owned())
            .or_default()
            .push((request.to_owned(), status, body.clone()));
        self.found.checked.insert(name.to_owned());
        let Some(t) = self.templates.get(name) else {
            self.note(format!("no template recorded for `{name}` ({request})"));
            return;
        };
        for m in t.check(status, body) {
            let counts = match &m {
                Mismatch::Shape(Difference::Missing { .. }) => self.mode == Mode::GitHub,
                Mismatch::Shape(Difference::Extra { .. }) => self.mode == Mode::Fake,
                _ => true,
            };
            if counts {
                self.found.drift.push(Drift {
                    template: name.to_owned(),
                    request: t.request.clone(),
                    what: m.to_string(),
                });
            }
        }
    }

    /// [`Checker::body`] for an answer.
    pub fn answer(&mut self, name: &str, request: &str, a: &Answer) {
        self.body(name, request, a.status, &a.body)
    }

    /// A GraphQL answer: GitHub's errors are drift (a field gone from its schema, say), and the
    /// rest is checked as any answer.
    pub fn graphql(&mut self, op: &str, a: &Answer) {
        let name = format!("graphql.{op}");
        if let Some(errors) = a.body["errors"].as_array().filter(|e| !e.is_empty()) {
            let what: Vec<String> = errors
                .iter()
                .map(|e| e["message"].as_str().unwrap_or("an error").to_owned())
                .collect();
            self.found.drift.push(Drift {
                template: name.clone(),
                request: format!("POST /graphql {op}"),
                what: format!("GitHub answered with errors: {}", what.join("; ")),
            });
        }
        self.answer(&name, &format!("POST /graphql {op}"), a);
    }

    /// A call that got no answer at all, or none the run could go on with.
    pub fn failed(&mut self, name: &str, request: &str, why: &str) {
        self.found.drift.push(Drift {
            template: name.to_owned(),
            request: request.to_owned(),
            what: format!("no usable answer: {why}"),
        });
    }

    /// A note, once however often it comes up.
    pub fn note(&mut self, note: impl Into<String>) {
        let note = note.into();
        if !self.found.notes.contains(&note) {
            self.found.notes.push(note);
        }
    }
}
