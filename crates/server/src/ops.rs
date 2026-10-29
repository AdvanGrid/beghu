//! Writes: `POST /api/ops` with `{op_id, op}`. Each op is one GitHub call, made with the user's
//! token in a task of its own, so a client that goes away mid-write doesn't cancel it. Every
//! answer but a comment's is compared with the request field by field (a comment's 201 is enough:
//! GitHub may keep its text its own way), since GitHub answers some refusals with a 2xx that
//! changed nothing. GitHub's answer is written to the mirror on the account's
//! writer lane (which pushes the issue's id to its tabs), and only then is the reply sent: a
//! fetch the tab starts after the reply sees the change. GitHub's answer carries the issue with
//! its `updated_at` (a label write's doesn't, so the issue is read after it, one GET), so the
//! webhook GitHub sends back for the write finds it in place and is a no-op.
//!
//! - `(account, op_id)` is remembered for [`REMEMBER`]: a resend joins the call in flight or gets
//!   its stored outcome, and never makes a second GitHub call.
//! - Ops on one issue take turns, in the order they arrive: each takes its place in its issue's
//!   queue as it's started.
//! - At most [`MAX_REMEMBERED`] ops per account are remembered; past that the oldest finished one
//!   is forgotten.
//! - A rate limit that lifts within [`QUIET_WAIT`] is waited out quietly; a longer one fails with
//!   "try again in N s".
//! - A label removal GitHub answers 404 "Label does not exist" is done: the label is off the
//!   issue, which is what was asked (a retry after a 5xx that GitHub had acted on meets this).
//!   Any other 404 (GitHub's "Not Found": the issue or repo is out of sight), a 410, or a 301
//!   (the issue transferred since, before its webhooks came) is Gone.
//! - 5xx answers, timeouts and resets are tried again after 1 s and then 3 s, except for a
//!   comment or a new issue, which is never sent twice: GitHub may have made it before failing,
//!   and the failure says so ("maybe posted" for a comment; for a new issue, "lost", which says
//!   to check the list).
//! - A new issue (`create`) names its repo, not an issue: it goes in a synced repo that isn't
//!   archived, and its labels, assignees and milestone need Triage (Read sends title and body
//!   only). GitHub drops any of the three it won't apply without saying so: the reply names
//!   each as the write that would apply it on the new issue, for the tab to show as failed there.
//!   New issues take turns per repo, as ops on one issue do.
//! - A refusal, or a close or reopen GitHub didn't apply, re-reads the account's role on that
//!   repo at once and says why in its terms.
//! - Only issues take writes: a PR, a stub or an issue outside the synced repos is refused.
//! - A label is added only by a name the mirror's repo has (GitHub would create one it lacks).
//! - While GitHub is down (see `github.rs`) a write fails at once, without a call.
//! - A title or body edit carries `base`, the text its editor opened with. `PATCH` has no
//!   `If-Match`, so the issue is read right before each patch attempt (the first, and each the
//!   retries above make after a wait), conditionally on the `ETag` of the last check or patch
//!   answer for that account and issue (kept in memory with the title and body it came with):
//!   an issue unchanged since is a 304, which costs nothing. So the first edit of an issue
//!   costs a full read; one after it (the next save, or "Overwrite with mine" after a 409)
//!   costs a 304 while no one else has changed the issue. If the field is the edit's `new`
//!   already (an edit that reached GitHub, sent again after the tab lost track of it), it's
//!   done, unpatched. If it's anything else but `base`, the edit fails as `Changed` (409) with
//!   GitHub's text, and nothing is patched. Only the race of one check-then-patch round trip
//!   remains (#10). (That a patch's `ETag` is the one a read names until the issue changes is
//!   Fake GitHub's model; only real GitHub can confirm it. Without it, a check is a full read.)
//!
//! - A comment that may have been posted says which comments can be it: those newer than the
//!   newest the mirror held as it was sent.
//! - A drain (SIGTERM, see `serve_until`) turns new ops away with 503 and `retry-after`, and
//!   waits for the ops under way; a resend of one it knows still joins it.
//!
//! There's no durable queue: a crash mid-write, or a write past the drain's limit, is lost. The
//! tab's resend then meets a server with no record of it and is answered "lost" (it may or may
//! not have reached GitHub), never sent again.

use crate::api::User;
use crate::auth::Session;
use crate::detail::Comment;
use crate::edges::{ReadBack, Subject};
use crate::error::ApiError;
use crate::github::{Access, Role, Shown};
use crate::live::Push;
use crate::markdown::{self, Digest, Md, Place, Post, PostKind, Refs};
use crate::relationship_writes::RelatedEnd;
use crate::{App, github, repos, tokens, webhook};
use axum::Json;
use axum::extract::{Extension, State};
use mirror_db::{Caller, q};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, watch};
use ts_rs::TS;

/// How long an `op_id` is remembered, so a resend never writes twice.
const REMEMBER: Duration = Duration::from_secs(10 * 60);
/// How many ops per account are remembered at most.
const MAX_REMEMBERED: usize = 500;
/// How long a refused write waits for the repo's role to be re-read, to say why in its terms.
const REREAD_WAIT: Duration = Duration::from_secs(2);
/// The longest rate limit waited out without failing the write.
const QUIET_WAIT: Duration = Duration::from_secs(10);
/// How many rate limits in a row one write waits out before failing.
const QUIET_WAITS: usize = 3;
/// The waits before each retry of a write that met a 5xx, a timeout or a reset.
const RETRIES: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];

/// The longest comment or body GitHub takes, in characters.
const MAX_BODY: usize = 65_536;
/// The longest title GitHub takes, in characters.
const MAX_TITLE: usize = 256;
/// How many issues' last checked `ETag`s are kept, across accounts; past that the oldest goes.
const MAX_CHECKED: usize = 2_000;

/// One write, in the tab's words: a tagged union on `kind`.
#[derive(Deserialize, Serialize, TS, Clone, PartialEq, Debug)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Op {
    /// Add a comment to the issue.
    Comment { issue: i64, body: String },
    /// Close the issue as completed or not planned.
    Close { issue: i64, reason: CloseReason },
    /// Reopen the issue.
    Reopen { issue: i64 },
    /// Add one of the repo's labels, by name, to the issue.
    LabelAdd { issue: i64, label: String },
    /// Take a label, by name, off the issue.
    LabelRemove { issue: i64, label: String },
    /// Assign a user, by login.
    AssigneeAdd { issue: i64, login: String },
    /// Unassign a user, by login.
    AssigneeRemove { issue: i64, login: String },
    /// Put the issue in one of the repo's milestones, by its number, or in none (`null`).
    MilestoneSet { issue: i64, milestone: Option<i64> },
    /// Set the title to `new`, if GitHub's is still `base`, the title the editor opened with.
    TitleEdit {
        issue: i64,
        new: String,
        base: String,
    },
    /// Set the body (Markdown) to `new`, if GitHub's is still `base`, the body the editor
    /// opened with.
    BodyEdit {
        issue: i64,
        new: String,
        base: String,
    },
    /// Open a new issue in a synced repo: labels by name, assignees by login, a milestone by its
    /// number. With `parent` (an issue's id), the new issue then becomes its last sub-issue, in
    /// the same write (a `sub_add`). The reply's `issue` is the new issue's id.
    Create {
        repo: i64,
        title: String,
        body: String,
        #[serde(default)]
        labels: Vec<String>,
        #[serde(default)]
        assignees: Vec<String>,
        #[serde(default)]
        milestone: Option<i64>,
        #[serde(default)]
        parent: Option<i64>,
    },
    /// Make `child` a sub-issue of the issue: last among its sub-issues, or after `after`, one of
    /// them. With `replace_parent`, a sub-issue of another parent moves here.
    SubAdd {
        issue: i64,
        child: RelatedEnd,
        replace_parent: bool,
        after: Option<i64>,
    },
    /// Take `child` out of the issue's sub-issues.
    SubRemove { issue: i64, child: RelatedEnd },
    /// Move the issue's sub-issue `child` after `after`, another of them, or to the top (`null`).
    SubReorder {
        issue: i64,
        child: i64,
        after: Option<i64>,
    },
    /// The issue is blocked by `other`, or with `blocking`, blocks it.
    BlockAdd {
        issue: i64,
        other: RelatedEnd,
        blocking: bool,
    },
    /// The issue is no longer blocked by `other`, or with `blocking`, no longer blocks it.
    BlockRemove {
        issue: i64,
        other: RelatedEnd,
        blocking: bool,
    },
    /// The issue relates to `other`.
    RelateAdd { issue: i64, other: RelatedEnd },
    /// The issue no longer relates to `other`.
    RelateRemove { issue: i64, other: RelatedEnd },
}

#[derive(Deserialize, Serialize, TS, Clone, Copy, PartialEq, Debug)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    Completed,
    NotPlanned,
}

impl CloseReason {
    fn github(self) -> &'static str {
        match self {
            CloseReason::Completed => "completed",
            CloseReason::NotPlanned => "not_planned",
        }
    }
}

/// What an item in the mirror is: only issues take writes.
#[derive(Clone, Copy, PartialEq, Debug)]
enum ItemKind {
    Issue,
    Pr,
}

impl ItemKind {
    /// From the mirror's `kind`: `issue` or `pr`; anything else is a mirror beghu can't read.
    fn of(kind: &str) -> Result<ItemKind, Failure> {
        match kind {
            "issue" => Ok(ItemKind::Issue),
            "pr" => Ok(ItemKind::Pr),
            _ => Err(Failure::Internal(format!(
                "an item of unknown kind {kind:?}"
            ))),
        }
    }
}

/// What an op is, without its fields.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum OpKind {
    Comment,
    Close,
    Reopen,
    LabelAdd,
    LabelRemove,
    AssigneeAdd,
    AssigneeRemove,
    MilestoneSet,
    TitleEdit,
    BodyEdit,
    Create,
    SubAdd,
    SubRemove,
    SubReorder,
    BlockAdd,
    BlockRemove,
    RelateAdd,
    RelateRemove,
}

impl OpKind {
    /// What a lost write of this kind says. The tab's own lost write (its resends unanswered)
    /// says the same, from `web/src/bindings/lostMessage.ts`, which `cargo test` writes from
    /// this.
    pub fn lost_message(self) -> &'static str {
        match self {
            OpKind::Comment => "May or may not have been sent; check the thread",
            OpKind::Close
            | OpKind::Reopen
            | OpKind::LabelAdd
            | OpKind::LabelRemove
            | OpKind::AssigneeAdd
            | OpKind::AssigneeRemove
            | OpKind::MilestoneSet
            | OpKind::TitleEdit
            | OpKind::BodyEdit
            | OpKind::SubAdd
            | OpKind::SubRemove
            | OpKind::SubReorder
            | OpKind::BlockAdd
            | OpKind::BlockRemove
            | OpKind::RelateAdd
            | OpKind::RelateRemove => "May or may not have reached GitHub",
            OpKind::Create => {
                "May or may not have been created; check the list before trying again"
            }
        }
    }
}

/// Where an op waits its turn: behind the earlier ops on its issue, or, for a new issue, behind
/// the earlier new issues in its repo.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Queue {
    Issue(i64),
    Repo(i64),
}

impl Op {
    /// The issue the op changes; none for a new issue.
    pub(crate) fn issue(&self) -> Option<i64> {
        match self {
            Op::Comment { issue, .. }
            | Op::Close { issue, .. }
            | Op::Reopen { issue }
            | Op::LabelAdd { issue, .. }
            | Op::LabelRemove { issue, .. }
            | Op::AssigneeAdd { issue, .. }
            | Op::AssigneeRemove { issue, .. }
            | Op::MilestoneSet { issue, .. }
            | Op::TitleEdit { issue, .. }
            | Op::BodyEdit { issue, .. }
            | Op::SubAdd { issue, .. }
            | Op::SubRemove { issue, .. }
            | Op::SubReorder { issue, .. }
            | Op::BlockAdd { issue, .. }
            | Op::BlockRemove { issue, .. }
            | Op::RelateAdd { issue, .. }
            | Op::RelateRemove { issue, .. } => Some(*issue),
            Op::Create { .. } => None,
        }
    }

    fn queue(&self) -> Queue {
        match (self, self.issue()) {
            (Op::Create { repo, .. }, _) => Queue::Repo(*repo),
            (_, Some(issue)) => Queue::Issue(issue),
            (_, None) => Queue::Repo(0),
        }
    }

    /// The queues the op takes its turn in, each once, in order: its own, and for a relationship
    /// write the other end's too when the tab knows its id (in ascending id order).
    fn queues(&self) -> Vec<Queue> {
        // A new issue with a parent takes its turn on the parent too, for the `sub_add` after it.
        if let Op::Create {
            repo,
            parent: Some(parent),
            ..
        } = self
        {
            return vec![Queue::Repo(*repo), Queue::Issue(*parent)];
        }
        let other = match self {
            Op::SubAdd { child, .. } | Op::SubRemove { child, .. } => child.id,
            Op::SubReorder { child, .. } => Some(*child),
            Op::BlockAdd { other, .. }
            | Op::BlockRemove { other, .. }
            | Op::RelateAdd { other, .. }
            | Op::RelateRemove { other, .. } => other.id,
            _ => return vec![self.queue()],
        };
        let mut items: Vec<i64> = [self.issue(), other].into_iter().flatten().collect();
        items.sort_unstable();
        items.dedup();
        items.into_iter().map(Queue::Issue).collect()
    }

    /// Whether it's a relationship write (`relationship_writes.rs` makes those).
    pub(crate) fn is_relationship(&self) -> bool {
        matches!(
            self.kind(),
            OpKind::SubAdd
                | OpKind::SubRemove
                | OpKind::SubReorder
                | OpKind::BlockAdd
                | OpKind::BlockRemove
                | OpKind::RelateAdd
                | OpKind::RelateRemove
        )
    }

    pub(crate) fn kind(&self) -> OpKind {
        match self {
            Op::Comment { .. } => OpKind::Comment,
            Op::Close { .. } => OpKind::Close,
            Op::Reopen { .. } => OpKind::Reopen,
            Op::LabelAdd { .. } => OpKind::LabelAdd,
            Op::LabelRemove { .. } => OpKind::LabelRemove,
            Op::AssigneeAdd { .. } => OpKind::AssigneeAdd,
            Op::AssigneeRemove { .. } => OpKind::AssigneeRemove,
            Op::MilestoneSet { .. } => OpKind::MilestoneSet,
            Op::TitleEdit { .. } => OpKind::TitleEdit,
            Op::BodyEdit { .. } => OpKind::BodyEdit,
            Op::Create { .. } => OpKind::Create,
            Op::SubAdd { .. } => OpKind::SubAdd,
            Op::SubRemove { .. } => OpKind::SubRemove,
            Op::SubReorder { .. } => OpKind::SubReorder,
            Op::BlockAdd { .. } => OpKind::BlockAdd,
            Op::BlockRemove { .. } => OpKind::BlockRemove,
            Op::RelateAdd { .. } => OpKind::RelateAdd,
            Op::RelateRemove { .. } => OpKind::RelateRemove,
        }
    }

    fn is_comment(&self) -> bool {
        self.kind() == OpKind::Comment
    }

    /// A comment's digest, which goes with a failure that may have posted it (see
    /// [`ErrorBody::digest`](crate::error::ErrorBody::digest)).
    fn digest(&self) -> Option<Digest> {
        match self {
            Op::Comment { body, .. } => Some(Digest::of(body)),
            Op::Close { .. }
            | Op::Reopen { .. }
            | Op::LabelAdd { .. }
            | Op::LabelRemove { .. }
            | Op::AssigneeAdd { .. }
            | Op::AssigneeRemove { .. }
            | Op::MilestoneSet { .. }
            | Op::TitleEdit { .. }
            | Op::BodyEdit { .. }
            | Op::Create { .. }
            | Op::SubAdd { .. }
            | Op::SubRemove { .. }
            | Op::SubReorder { .. }
            | Op::BlockAdd { .. }
            | Op::BlockRemove { .. }
            | Op::RelateAdd { .. }
            | Op::RelateRemove { .. } => None,
        }
    }

    /// For a title or body edit: the field it edits, the text its editor opened with, and the
    /// text it sets.
    fn edits(&self) -> Option<(Field, &str, &str)> {
        match self {
            Op::TitleEdit { base, new, .. } => Some((Field::Title, base, new)),
            Op::BodyEdit { base, new, .. } => Some((Field::Body, base, new)),
            _ => None,
        }
    }

    /// Whether a 5xx, timeout or reset is tried again: not for a comment or a new issue, which
    /// GitHub may have made before failing. Every other op leaves the issue as it asks however
    /// often it's made.
    fn retries(&self) -> bool {
        !matches!(self.kind(), OpKind::Comment | OpKind::Create)
    }

    /// What the op names that must not be blank: a label, a login, or a title.
    fn blank_name(&self) -> Option<&'static str> {
        match self {
            Op::LabelAdd { label, .. } | Op::LabelRemove { label, .. }
                if label.trim().is_empty() =>
            {
                Some("a label needs a name")
            }
            Op::AssigneeAdd { login, .. } | Op::AssigneeRemove { login, .. }
                if login.trim().is_empty() =>
            {
                Some("an assignee needs a login")
            }
            Op::TitleEdit { new, .. } if new.trim().is_empty() => Some("A title can't be empty"),
            Op::Create { title, .. } if title.trim().is_empty() => {
                Some("A new issue needs a title")
            }
            Op::SubAdd { child: e, .. }
            | Op::SubRemove { child: e, .. }
            | Op::BlockAdd { other: e, .. }
            | Op::BlockRemove { other: e, .. }
            | Op::RelateAdd { other: e, .. }
            | Op::RelateRemove { other: e, .. }
                if e.id.is_none()
                    && (e.owner.trim().is_empty() || e.repo.trim().is_empty() || e.number < 1) =>
            {
                Some("a related issue needs its owner, repo and number")
            }
            _ => None,
        }
    }

    /// Why the op is more than GitHub takes, in words for the user: a comment or body longer than
    /// [`MAX_BODY`], a title longer than [`MAX_TITLE`].
    fn too_long(&self) -> Option<&'static str> {
        match self {
            Op::Comment { body, .. } if body.chars().count() > MAX_BODY => {
                Some("A comment can be at most 65,536 characters long, as on GitHub")
            }
            Op::BodyEdit { new: body, .. } | Op::Create { body, .. }
                if body.chars().count() > MAX_BODY =>
            {
                Some("A description can be at most 65,536 characters long, as on GitHub")
            }
            Op::TitleEdit { new: title, .. } | Op::Create { title, .. }
                if title.trim().chars().count() > MAX_TITLE =>
            {
                Some("A title can be at most 256 characters long, as on GitHub")
            }
            _ => None,
        }
    }
}

/// The text field a title or body edit changes.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Field {
    Title,
    Body,
}

impl Field {
    /// The field in GitHub's `(title, body)`.
    fn of(self, (title, body): &(String, String)) -> &str {
        match self {
            Field::Title => title,
            Field::Body => body,
        }
    }
}

/// Whether two texts of a field are the same, as GitHub keeps them: a title without the
/// whitespace around it, and a body with any line ends (GitHub keeps a browser's `\r\n` as sent;
/// a textarea gives `\n`).
fn same_text(field: Field, a: &str, b: &str) -> bool {
    match field {
        Field::Title => a.trim() == b.trim(),
        Field::Body => a.replace("\r\n", "\n") == b.replace("\r\n", "\n"),
    }
}

/// `POST /api/ops`'s body.
#[derive(Deserialize, TS)]
#[ts(export)]
pub struct OpRequest {
    /// The tab's id for this write; a resend after a dropped connection sends the same one.
    pub op_id: String,
    pub op: Op,
    /// The tab sent this op before and got no answer. A resend of an `op_id` the server has no
    /// record of (it restarted, or forgot the op after [`REMEMBER`]) is [`ApiError::Lost`]: the
    /// first send may have reached GitHub, so it's never sent again.
    #[serde(default)]
    #[ts(optional)]
    pub resend: Option<bool>,
}

/// What a write did, once GitHub has it and the mirror too.
#[derive(Serialize, TS, Clone)]
#[ts(export)]
pub struct OpReply {
    pub issue: i64,
    /// A comment op's comment, as the thread will show it.
    pub comment: Option<Comment>,
    /// A body edit's body, rendered, as the detail will show it.
    #[ts(type = "import(\"../md/ast\").Md | null")]
    pub body: Option<Md>,
    /// The items in the mirror that the comment or the body refers to.
    pub refs: Refs,
    /// What GitHub didn't apply of what the write asked, though the write itself was made: a
    /// create's labels, assignees, milestone or parent, or a move's place among its new siblings.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<Unapplied>>", optional)]
    pub unapplied: Vec<Unapplied>,
}

/// What GitHub left out of a write it made: each as the write that would apply it, and why, in
/// words for the user (for a create's labels, assignees or milestone, in terms of the account's
/// role).
#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Unapplied {
    pub ops: Vec<Op>,
    pub why: String,
}

/// How a write ended: kept for resends, so it's cloneable (unlike [`ApiError`]).
#[derive(Clone, Debug)]
pub(crate) enum Failure {
    Gone,
    SignedOut,
    Refused(String),
    RateLimited(Duration),
    Conflict(String),
    /// A title or body edit's field isn't its `base` on GitHub any more: GitHub's text now.
    Changed(String),
    GitHubDown(String),
    /// GitHub answered 403: [`run`] words it as a [`Failure::Refused`] from the role.
    Forbidden,
    /// GitHub answered a label removal 404 "Label does not exist": [`run`] takes it as done.
    NoSuchLabel,
    /// GitHub answered 422, with its message: a relationship write reads it (an "already
    /// exists" is done); any other write is refused.
    Unprocessable(String),
    /// beghu refused the write before any call, as it stands: GitHub would refuse it too (a
    /// relationship that would make a loop, say). The reason, in words for the user.
    Invalid(String),
    /// A comment GitHub answered with a 5xx or a 2xx beghu couldn't read, or not at all: it may
    /// have been posted. `after` and `digest`: as in [`ApiError::MaybePosted`].
    MaybePosted {
        after: i64,
        digest: Option<Digest>,
    },
    /// A new issue GitHub answered with a 5xx or a 2xx beghu couldn't read, or not at all: it may
    /// have been made. Never sent again; the tab is told to check, as for a lost write.
    MaybeCreated,
    /// The drain stopped the jobs before the write's token could be refreshed: nothing was sent.
    Restarting,
    /// A mirror said to try again later (at its connection cap, or migrating): nothing was sent.
    Unavailable {
        retry_after: Duration,
        why: String,
    },
    Internal(String),
}

impl From<Failure> for ApiError {
    fn from(f: Failure) -> ApiError {
        match f {
            Failure::Gone | Failure::NoSuchLabel => ApiError::Gone,
            Failure::Unprocessable(_) => {
                ApiError::Refused("GitHub couldn't apply this change".into())
            }
            Failure::Invalid(m) => ApiError::BadRequest(m),
            Failure::SignedOut => ApiError::SignedOut,
            Failure::Refused(m) => ApiError::Refused(m),
            Failure::Forbidden => ApiError::Refused("GitHub didn't apply this change".into()),
            Failure::RateLimited(retry_after) => ApiError::RateLimited { retry_after },
            Failure::Conflict(m) => ApiError::Conflict(m),
            Failure::Changed(current) => ApiError::Changed { current },
            Failure::GitHubDown(m) => ApiError::GitHubDown(m),
            Failure::MaybePosted { after, digest } => ApiError::MaybePosted { after, digest },
            Failure::MaybeCreated => ApiError::Lost {
                kind: OpKind::Create,
                digest: None,
            },
            Failure::Restarting => ApiError::restarting(),
            Failure::Unavailable { retry_after, why } => ApiError::Unavailable { retry_after, why },
            Failure::Internal(m) => ApiError::Internal(m),
        }
    }
}

impl Failure {
    /// What the failure says to the user, as its API error's message would.
    pub(crate) fn words(&self) -> String {
        match self {
            Failure::Gone | Failure::NoSuchLabel => {
                "That issue isn't in your synced repos (any more)".into()
            }
            Failure::SignedOut => "Sign in to continue".into(),
            Failure::Refused(m)
            | Failure::Invalid(m)
            | Failure::Conflict(m)
            | Failure::GitHubDown(m) => m.clone(),
            Failure::RateLimited(w) => {
                format!("GitHub's rate limit: try again in {} s", w.as_secs().max(1))
            }
            Failure::Changed(_) => "Changed on GitHub meanwhile".into(),
            Failure::Forbidden => "GitHub didn't apply this change".into(),
            Failure::Unprocessable(_) => "GitHub couldn't apply this change".into(),
            Failure::MaybePosted { .. } | Failure::MaybeCreated => {
                "May or may not have reached GitHub".into()
            }
            Failure::Restarting => "beghu is restarting; try again in a moment".into(),
            Failure::Unavailable { why, .. } => why.clone(),
            Failure::Internal(_) => "Something went wrong".into(),
        }
    }
}

impl From<dbrt::Error> for Failure {
    /// A mirror read the drain's seal refused (it can't open a mirror any more): beghu is
    /// restarting, and nothing was sent. One that says to try again later is a 503 with
    /// `retry-after`, as `From<dbrt::Error> for ApiError` makes it.
    fn from(e: dbrt::Error) -> Failure {
        match (&e, e.retry_after()) {
            (dbrt::Error::Sealed, _) => Failure::Restarting,
            (_, Some(retry_after)) => Failure::Unavailable {
                retry_after,
                why: e.to_string(),
            },
            _ => Failure::Internal(e.to_string()),
        }
    }
}

pub(crate) type Outcome = Result<OpReply, Failure>;

/// The writes in flight and lately done, and each issue's queue, under one lock: an op takes
/// its turn on its issue as it arrives. And how many ops and requests for them are under way,
/// for the drain to wait on.
pub struct Ops {
    book: Mutex<Book>,
    busy: watch::Sender<usize>,
    /// Per account and issue, what GitHub last answered a title or body edit's check or patch
    /// with.
    checked: Mutex<HashMap<(i64, i64), Checked>>,
}

impl Default for Ops {
    fn default() -> Ops {
        Ops {
            book: Mutex::default(),
            busy: watch::channel(0).0,
            checked: Mutex::default(),
        }
    }
}

/// An issue as GitHub last answered a title or body edit's check or patch: the answer's `ETag`,
/// and the title and body it carried, which a 304 to that `ETag` says are still GitHub's.
#[derive(Clone)]
struct Checked {
    etag: String,
    text: (String, String),
    at: Instant,
}

/// One op task or `/api/ops` request under way, until dropped.
struct Busy(watch::Sender<usize>);

impl Busy {
    fn new(busy: &watch::Sender<usize>) -> Busy {
        busy.send_modify(|n| *n += 1);
        Busy(busy.clone())
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.send_modify(|n| *n -= 1);
    }
}

#[derive(Default)]
struct Book {
    seen: HashMap<(i64, String), Seen>,
    /// Per queue (an issue, or a repo's new issues), the last op to take a turn: its number, and
    /// what ends when it's done. An op that finds one waits on it; the last one done removes its
    /// entry.
    last: HashMap<Queue, (u64, oneshot::Receiver<()>)>,
    next: u64,
}

/// One `op_id`'s write: what it was, when it started, and its outcome once it has one.
struct Seen {
    op: Op,
    at: Instant,
    outcome: watch::Receiver<Option<Outcome>>,
}

impl Ops {
    fn book(&self) -> std::sync::MutexGuard<'_, Book> {
        self.book.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn checked(&self) -> std::sync::MutexGuard<'_, HashMap<(i64, i64), Checked>> {
        self.checked.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// What GitHub last answered `account`'s check or patch of `issue` with, if it's kept.
    fn last_check(&self, account: i64, issue: i64) -> Option<Checked> {
        self.checked().get(&(account, issue)).cloned()
    }

    /// Keeps GitHub's `ETag` for `account`'s check or patch of `issue`, with its title and body;
    /// past [`MAX_CHECKED`] the oldest kept goes.
    fn note_check(&self, account: i64, issue: i64, etag: String, text: (String, String)) {
        let mut checked = self.checked();
        if checked.len() >= MAX_CHECKED && !checked.contains_key(&(account, issue)) {
            let oldest = checked.iter().min_by_key(|(_, c)| c.at).map(|(k, _)| *k);
            if let Some(k) = oldest {
                checked.remove(&k);
            }
        }
        checked.insert(
            (account, issue),
            Checked {
                etag,
                text,
                at: Instant::now(),
            },
        );
    }

    /// Resolves once no op and no request for one is under way.
    pub async fn idle(&self) {
        let _ = self.busy.subscribe().wait_for(|n| *n == 0).await;
    }

    /// The write `op_id` names: the one already started, or a new one, which takes its turn on
    /// its issue now. A resend of an `op_id` with a different op is a client bug: 400. A resend
    /// of one the server has no record of is lost. While the server drains, a new one is turned
    /// away.
    fn join_or_start(
        &self,
        app: &App,
        account: i64,
        op_id: String,
        op: Op,
        resend: bool,
    ) -> Result<watch::Receiver<Option<Outcome>>, ApiError> {
        let mut book = self.book();
        book.seen
            .retain(|_, s| s.at.elapsed() < REMEMBER || s.outcome.borrow().is_none());
        let key = (account, op_id);
        if let Some(s) = book.seen.get(&key) {
            if s.op != op {
                return Err(ApiError::BadRequest(format!(
                    "op_id {:?} was used for another op",
                    key.1
                )));
            }
            return Ok(s.outcome.clone());
        }
        if resend {
            return Err(ApiError::Lost {
                kind: op.kind(),
                digest: op.digest(),
            });
        }
        if app.draining() {
            return Err(ApiError::Unavailable {
                retry_after: Duration::from_secs(5),
                why: "beghu is restarting; the change will be sent again in a moment".into(),
            });
        }
        make_room(&mut book.seen, account)?;
        let (tx, rx) = watch::channel(None);
        book.seen.insert(
            key.clone(),
            Seen {
                op: op.clone(),
                at: Instant::now(),
                outcome: rx.clone(),
            },
        );
        // The turn: after the last op in each of its queues, before any that arrives later. A
        // relationship write takes its turn on both ends at once, in ascending id order, under
        // the book's one lock: every op waits only on ops that arrived before it, so two writes
        // on two linked issues can't wait on each other.
        let queues = op.queues();
        let turn = book.next;
        book.next += 1;
        let mut before = Vec::new();
        let mut done = Vec::new();
        for &queue in &queues {
            let (tx, rx) = oneshot::channel();
            done.push(tx);
            before.extend(book.last.insert(queue, (turn, rx)).map(|(_, rx)| rx));
        }
        let end = End {
            _busy: Busy::new(&self.busy),
            app: app.clone(),
            queues,
            turn,
            sending: Sending {
                kind: Some(op.kind()),
                digest: op.digest(),
                ..Sending::default()
            },
            tx,
            _done: done,
        };
        drop(book);
        // Its own task: the request that started it may go away; the write carries on. A job, so
        // a write the drain's step 3 didn't see finish in time is stopped at step 4.
        app.jobs().spawn(async move {
            for before in before {
                // Done, or its task ended some other way: either way it's this op's turn.
                let _ = before.await;
            }
            let outcome = run(&end.app, account, &op, &end.sending).await;
            if let Err(f) = &outcome {
                eprintln!("ops: account {account}: {op:?} failed: {f:?}");
            }
            if let Err(Failure::Unavailable { .. }) = &outcome {
                // Nothing was sent: the tab's resend after `retry-after` starts it afresh, rather
                // than being answered the same 503.
                end.app.ops().book().seen.remove(&key);
            }
            let _ = end.tx.send(Some(outcome));
        });
        Ok(rx)
    }
}

/// Room for one more of `account`'s ops in `seen`: past [`MAX_REMEMBERED`], its oldest finished
/// op is forgotten (a resend of it is then lost, never sent twice). With that many in flight,
/// the new one waits.
fn make_room(seen: &mut HashMap<(i64, String), Seen>, account: i64) -> Result<(), ApiError> {
    let mine = seen.keys().filter(|(a, _)| *a == account).count();
    if mine < MAX_REMEMBERED {
        return Ok(());
    }
    let oldest = seen
        .iter()
        .filter(|((a, _), s)| *a == account && s.outcome.borrow().is_some())
        .min_by_key(|(_, s)| s.at)
        .map(|(k, _)| k.clone());
    match oldest {
        Some(k) => {
            seen.remove(&k);
            Ok(())
        }
        None => Err(ApiError::Unavailable {
            retry_after: Duration::from_secs(5),
            why: format!("{MAX_REMEMBERED} writes are already on their way"),
        }),
    }
}

/// The end of an op's task, however it ends: an outcome for whoever waits on it (a task that
/// panicked fails rather than leaving them waiting: as `MaybePosted` for a comment whose call
/// may have gone out, `MaybeCreated` for such a new issue, else as `Internal`), its queue's next
/// op's turn, and the queue's entry gone if no op came after.
struct End {
    _busy: Busy,
    app: App,
    /// The queues it took its turn in.
    queues: Vec<Queue>,
    turn: u64,
    sending: Sending,
    tx: watch::Sender<Option<Outcome>>,
    /// Dropped last: the next op in each of its queues waits on it.
    _done: Vec<oneshot::Sender<()>>,
}

impl Drop for End {
    fn drop(&mut self) {
        let sent = self.sending.sent.load(Ordering::SeqCst);
        self.tx.send_if_modified(|o| {
            o.is_none()
                .then(|| {
                    *o = Some(Err(match self.sending.unsure() {
                        Some(f) if sent => f,
                        _ => Failure::Internal("the write's task ended without an outcome".into()),
                    }));
                })
                .is_some()
        });
        let mut book = self.app.ops().book();
        for queue in &self.queues {
            if book.last.get(queue).is_some_and(|(t, _)| *t == self.turn) {
                book.last.remove(queue);
            }
        }
    }
}

/// What an op's task knows of its GitHub call, for an end that comes without an outcome.
#[derive(Default)]
pub(crate) struct Sending {
    /// What the op is.
    kind: Option<OpKind>,
    /// Set as the call goes out.
    sent: AtomicBool,
    /// For a comment: the newest comment id the mirror held on the issue as the call went out.
    after: AtomicI64,
    /// For a comment: its digest ([`Op::digest`]).
    digest: Option<Digest>,
}

impl Sending {
    /// The comment may have been posted.
    fn maybe_posted(&self) -> Failure {
        Failure::MaybePosted {
            after: self.after.load(Ordering::SeqCst),
            digest: self.digest,
        }
    }

    /// For an op that's never sent twice, once its call may have reached GitHub: that GitHub may
    /// have made it. `None` for every other op.
    fn unsure(&self) -> Option<Failure> {
        match self.kind {
            Some(OpKind::Comment) => Some(self.maybe_posted()),
            Some(OpKind::Create) => Some(Failure::MaybeCreated),
            _ => None,
        }
    }
}

pub async fn post(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Json(req): Json<OpRequest>,
) -> Result<Json<OpReply>, ApiError> {
    // Counted before the drain is checked, so the drain never misses it.
    let _busy = Busy::new(&app.ops().busy);
    if !is_uuid(&req.op_id) {
        return Err(ApiError::BadRequest(
            "op_id must be a UUID, like crypto.randomUUID() makes".into(),
        ));
    }
    if let Some(why) = req.op.blank_name() {
        return Err(ApiError::BadRequest(why.into()));
    }
    if let Op::Comment { body, .. } = &req.op
        && body.trim().is_empty()
    {
        return Err(ApiError::BadRequest("a comment needs some text".into()));
    }
    if let Some(why) = req.op.too_long() {
        return Err(ApiError::BadRequest(why.into()));
    }
    let mut outcome = app.ops().join_or_start(
        &app,
        s.account,
        req.op_id,
        req.op,
        req.resend.unwrap_or(false),
    )?;
    let done = outcome
        .wait_for(Option::is_some)
        .await
        .map_err(|_| ApiError::Internal("the write's task ended without an outcome".into()))?
        .clone();
    match done {
        Some(Ok(reply)) => Ok(Json(reply)),
        Some(Err(f)) => Err(f.into()),
        None => Err(ApiError::Internal("no outcome".into())),
    }
}

/// Whether `s` is a UUID in its usual spelling: 32 hex digits in groups of 8-4-4-4-12.
fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Makes the write: GitHub, then the mirror and the push.
async fn run(app: &App, account: i64, op: &Op, sending: &Sending) -> Outcome {
    if op.is_relationship() {
        return crate::relationship_writes::run(app, account, op, sending).await;
    }
    let Some(id) = op.issue() else {
        return create(app, account, op, sending).await;
    };
    let target = writable(app, account, id).await?;
    let issue_path = format!(
        "/repos/{}/{}/issues/{}",
        target.owner, target.repo, target.number
    );
    let (method, path, body) = match op {
        Op::Comment { body, .. } => (
            reqwest::Method::POST,
            format!("{issue_path}/comments"),
            json!({ "body": body }),
        ),
        Op::Close { reason, .. } => (
            reqwest::Method::PATCH,
            issue_path,
            json!({ "state": "closed", "state_reason": reason.github() }),
        ),
        Op::Reopen { .. } => (
            reqwest::Method::PATCH,
            issue_path,
            json!({ "state": "open" }),
        ),
        // GitHub creates a label it's asked to add by a name the repo doesn't have: a name the
        // tab read before a rename would make a second label. Only a label the mirror has is
        // added, by the name the mirror has for it.
        Op::LabelAdd { label, .. } => {
            let (repo, name) = (target.repo_id, label.clone());
            let named = app
                .mirrors()
                .read(account, Caller::Request, move |c| {
                    q::repo_label_named(c, repo, &name)
                })
                .await
                .map_err(Failure::from)?
                .ok_or_else(|| {
                    Failure::Refused(format!(
                        "{} has no label called {label}; it may have been renamed or deleted",
                        target.repo
                    ))
                })?;
            (
                reqwest::Method::POST,
                format!("{issue_path}/labels"),
                json!({ "labels": [named.name] }),
            )
        }
        Op::LabelRemove { label, .. } => (
            reqwest::Method::DELETE,
            format!("{issue_path}/labels/{}", path_segment(label)),
            serde_json::Value::Null,
        ),
        Op::AssigneeAdd { login, .. } => (
            reqwest::Method::POST,
            format!("{issue_path}/assignees"),
            json!({ "assignees": [login] }),
        ),
        Op::AssigneeRemove { login, .. } => (
            reqwest::Method::DELETE,
            format!("{issue_path}/assignees"),
            json!({ "assignees": [login] }),
        ),
        Op::MilestoneSet { milestone, .. } => (
            reqwest::Method::PATCH,
            issue_path,
            json!({ "milestone": milestone }),
        ),
        Op::Create { .. } => return Err(Failure::Internal("a new issue names no issue".into())),
        Op::SubAdd { .. }
        | Op::SubRemove { .. }
        | Op::SubReorder { .. }
        | Op::BlockAdd { .. }
        | Op::BlockRemove { .. }
        | Op::RelateAdd { .. }
        | Op::RelateRemove { .. } => {
            return Err(Failure::Internal(
                "a relationship write is made in relationship_writes.rs".into(),
            ));
        }
        Op::TitleEdit { new, .. } => (
            reqwest::Method::PATCH,
            issue_path,
            json!({ "title": new.trim() }),
        ),
        Op::BodyEdit { new, .. } => (reqwest::Method::PATCH, issue_path, json!({ "body": new })),
    };
    let on = IssueRepo {
        repo_id: target.repo_id,
        owner: target.owner.clone(),
        repo: target.repo.clone(),
        own: target.author_id == Some(account),
    };
    if op.is_comment() {
        let after = app
            .mirrors()
            .read(account, Caller::Request, move |c| {
                q::newest_comment_id(c, id)
            })
            .await
            .map_err(Failure::from)?;
        sending.after.store(after, Ordering::SeqCst);
    }
    let answer = match op.edits() {
        // A title or body edit is made only over the text its editor opened with.
        Some(_) => match edit(app, account, &target, op, method, &path, &body, sending).await {
            Ok(Edited::Patched(answer)) => Ok(answer),
            Ok(Edited::Already(now)) => {
                let body = matches!(op, Op::BodyEdit { .. }).then_some(now.1);
                return Ok(edited(app, account, &target, body).await);
            }
            Ok(Edited::Changed(theirs)) => return Err(Failure::Changed(theirs)),
            Err(e) => Err(e),
        },
        None => call(app, account, op, method, &path, &body, sending).await,
    };
    let answer = match answer {
        Err(Failure::Forbidden) => {
            return Err(Failure::Refused(refused_why(app, account, &on, op).await));
        }
        // The label isn't on the issue: what the removal asked for.
        Err(Failure::NoSuchLabel) => serde_json::json!([]),
        answer => answer?,
    };
    let repo = target.repo_id;
    match op {
        // A 201 is a posted comment, whatever its text came back as: GitHub may keep a body in
        // a form of its own. The thread shows GitHub's.
        Op::Comment { .. } => {
            // GitHub posted it, but an answer beghu can't read doesn't say as what.
            let c: webhook::Comment = serde_json::from_value(answer).map_err(|e| {
                eprintln!("ops: account {account}: GitHub's 2xx for a comment: {e}");
                sending.maybe_posted()
            })?;
            let (comment_id, md) = (c.id, c.body.clone());
            let author = c.user.as_ref().map(|u| User {
                login: u.login.clone(),
            });
            let created_at = c.created_at.as_deref().map_or(0, webhook::time);
            let updated_at = webhook::time(&c.updated_at);
            store(app, account, &target, move |tx, seq| {
                webhook::write_comment(tx, id, &c, seq)
            })
            .await;
            let post = Post {
                kind: PostKind::Comment,
                id: comment_id,
                md,
            };
            // Posted and stored: rendered, or as plain text if that failed, never a failure.
            let rendered = markdown::render(app, Place::from(&target), vec![post])
                .await
                .remove(0);
            let comment = Comment {
                id: comment_id,
                author,
                body: rendered.md,
                digest: rendered.digest,
                created_at,
                updated_at,
            };
            // Which of its references the mirror holds; none if that can't be read now (the
            // thread's refetch reads them again).
            let ask = comment.body.clone();
            let refs = app
                .mirrors()
                .read(account, Caller::Request, move |c| markdown::refs(c, [&ask]))
                .await
                .unwrap_or_else(|e| {
                    eprintln!("ops: account {account}: the refs of comment {comment_id}: {e}");
                    Refs::new()
                });
            Ok(OpReply {
                issue: id,
                comment: Some(comment),
                body: None,
                refs,
                unapplied: Vec::new(),
            })
        }
        // GitHub answers with the labels the issue has afterwards, but not the issue's
        // `updated_at`. The change asked for is written at once (a newer change by someone else
        // may be in the mirror already); then the issue is read, one GET, and written as GitHub
        // has it, so the `labeled` or `unlabeled` delivery that follows finds itself in place.
        Op::LabelAdd { label, .. } | Op::LabelRemove { label, .. } => {
            let labels: Vec<webhook::Label> = serde_json::from_value(answer)
                .map_err(|e| Failure::Internal(format!("GitHub's labels: {e}")))?;
            let has = labels.iter().find(|l| l.name.eq_ignore_ascii_case(label));
            let add = matches!(op, Op::LabelAdd { .. });
            if add != has.is_some() {
                return Err(Failure::Refused(refused_why(app, account, &on, op).await));
            }
            let (label, has) = (label.clone(), has.cloned());
            store(app, account, &target, move |tx, seq| match has {
                Some(l) => webhook::link_label(tx, repo, id, &l, seq),
                None => webhook::unlink_label(tx, repo, id, &label, seq),
            })
            .await;
            read_back(app, account, &target).await;
            Ok(OpReply {
                issue: id,
                comment: None,
                body: None,
                refs: Refs::new(),
                unapplied: Vec::new(),
            })
        }
        Op::Create { .. } => Err(Failure::Internal("a new issue names no issue".into())),
        Op::SubAdd { .. }
        | Op::SubRemove { .. }
        | Op::SubReorder { .. }
        | Op::BlockAdd { .. }
        | Op::BlockRemove { .. }
        | Op::RelateAdd { .. }
        | Op::RelateRemove { .. } => Err(Failure::Internal(
            "a relationship write is made in relationship_writes.rs".into(),
        )),
        Op::Close { .. }
        | Op::Reopen { .. }
        | Op::AssigneeAdd { .. }
        | Op::AssigneeRemove { .. }
        | Op::MilestoneSet { .. }
        | Op::TitleEdit { .. }
        | Op::BodyEdit { .. } => {
            let issue: webhook::Issue = serde_json::from_value(answer)
                .map_err(|e| Failure::Internal(format!("GitHub's issue: {e}")))?;
            let assigned = |login: &str| {
                issue
                    .assignees
                    .iter()
                    .any(|u| u.login.eq_ignore_ascii_case(login))
            };
            let applied = match op {
                Op::Close { reason, .. } => {
                    issue.state == "closed"
                        && issue.state_reason.as_deref() == Some(reason.github())
                }
                Op::AssigneeAdd { login, .. } => assigned(login),
                Op::AssigneeRemove { login, .. } => !assigned(login),
                Op::MilestoneSet { milestone, .. } => {
                    issue.milestone.as_ref().map(|m| m.number) == *milestone
                }
                Op::TitleEdit { new, .. } => same_text(Field::Title, issue.title(), new),
                Op::BodyEdit { new, .. } => same_text(Field::Body, issue.body(), new),
                Op::Reopen { .. } => issue.state == "open",
                _ => return Err(Failure::Internal(format!("{op:?} took the wrong path"))),
            };
            let body = matches!(op, Op::BodyEdit { .. }).then(|| issue.body().to_owned());
            store(app, account, &target, move |tx, seq| {
                webhook::write_issue(tx, repo, &issue, seq)
            })
            .await;
            if !applied {
                return Err(Failure::Refused(refused_why(app, account, &on, op).await));
            }
            Ok(edited(app, account, &target, body).await)
        }
    }
}

/// Makes a new issue: GitHub, then the mirror and the push, as for any other write. GitHub's
/// answer is the issue as made; what it left out of what was asked comes back in the reply's
/// `unapplied`, since the issue is there all the same.
async fn create(app: &App, account: i64, op: &Op, sending: &Sending) -> Outcome {
    let Op::Create {
        repo,
        title,
        body,
        labels,
        assignees,
        milestone,
        parent,
    } = op
    else {
        return Err(Failure::Internal(format!("{op:?} isn't a new issue")));
    };
    let repo = *repo;
    let target = app
        .mirrors()
        .read(account, Caller::Request, move |c| q::create_target(c, repo))
        .await
        .map_err(Failure::from)?
        .filter(|r| r.synced)
        .ok_or_else(|| Failure::Refused("This repo isn't synced".into()))?;
    let name = &target.name;
    read_only_here(app, &target.owner, name)?;
    if target.archived {
        return Err(Failure::Refused(format!(
            "{name} is archived, so it's read-only"
        )));
    }
    // Read opens issues with a title and a body only; a role not read yet is GitHub's to judge.
    let role = target.role.as_deref().and_then(Role::parse);
    let extras = !labels.is_empty() || !assignees.is_empty() || milestone.is_some();
    if let Some(role) = role.filter(|r| (extras || parent.is_some()) && *r < Role::Triage) {
        let what = if parent.is_some() {
            "labels, assignees, a milestone or a parent"
        } else {
            "labels, assignees or a milestone"
        };
        return Err(Failure::Refused(format!(
            "you have {} on {name}, which can't set {what}",
            role.name()
        )));
    }
    if app.github().is_down() {
        return Err(Failure::GitHubDown(
            "GitHub is unreachable; try again once it's back".into(),
        ));
    }
    // As for `label_add`: only labels the mirror's repo has, by the name it has for each, since
    // GitHub would create one it lacks.
    let mut names = Vec::with_capacity(labels.len());
    for label in labels {
        let wanted = label.clone();
        let named = app
            .mirrors()
            .read(account, Caller::Request, move |c| {
                q::repo_label_named(c, repo, &wanted)
            })
            .await
            .map_err(Failure::from)?
            .ok_or_else(|| {
                Failure::Refused(format!(
                    "{name} has no label called {label}; it may have been renamed or deleted"
                ))
            })?;
        names.push(named.name);
    }
    let mut ask = json!({ "title": title.trim(), "body": body });
    if !names.is_empty() {
        ask["labels"] = json!(names);
    }
    if !assignees.is_empty() {
        ask["assignees"] = json!(assignees);
    }
    if let Some(m) = milestone {
        ask["milestone"] = json!(m);
    }
    let on = IssueRepo {
        repo_id: repo,
        owner: target.owner.clone(),
        repo: target.name.clone(),
        own: true,
    };
    let path = format!("/repos/{}/{name}/issues", target.owner);
    let answer = match call(
        app,
        account,
        op,
        reqwest::Method::POST,
        &path,
        &ask,
        sending,
    )
    .await
    {
        Err(Failure::Forbidden) => {
            return Err(Failure::Refused(refused_why(app, account, &on, op).await));
        }
        // 404: out of sight now; 410: the repo has issues turned off.
        Err(Failure::Gone) => {
            return Err(Failure::Refused(format!(
                "GitHub won't take new issues in {name}: it may have issues turned off, or be out of your reach"
            )));
        }
        answer => answer?,
    };
    // GitHub made it, but an answer beghu can't read doesn't say as what.
    let issue: webhook::Issue = serde_json::from_value(answer).map_err(|e| {
        eprintln!("ops: account {account}: GitHub's 201 for a new issue: {e}");
        Failure::MaybeCreated
    })?;
    let id = issue.id();
    // What it was asked for and doesn't have, as the writes that would apply it.
    let mut unapplied: Vec<Op> = Vec::new();
    for label in &names {
        if !issue.label_names().any(|l| l.eq_ignore_ascii_case(label)) {
            unapplied.push(Op::LabelAdd {
                issue: id,
                label: label.clone(),
            });
        }
    }
    for login in assignees {
        if !issue
            .assignees
            .iter()
            .any(|u| u.login.eq_ignore_ascii_case(login))
        {
            unapplied.push(Op::AssigneeAdd {
                issue: id,
                login: login.clone(),
            });
        }
    }
    if milestone.is_some() && issue.milestone.as_ref().map(|m| m.number) != *milestone {
        unapplied.push(Op::MilestoneSet {
            issue: id,
            milestone: *milestone,
        });
    }
    let made = q::OpTargetRow {
        id,
        node_id: issue.node_id().to_owned(),
        kind: "issue".into(),
        is_stub: false,
        synced: true,
        repo_id: repo,
        installation_id: target.installation_id,
        owner: target.owner.clone(),
        repo: target.name.clone(),
        number: issue.number(),
        author_id: Some(account),
    };
    store(app, account, &made, move |tx, seq| {
        webhook::write_issue(tx, repo, &issue, seq)
    })
    .await;
    let mut left = Vec::new();
    if let Some(first) = unapplied.first() {
        left.push(Unapplied {
            why: refused_why(app, account, &on, first).await,
            ops: unapplied,
        });
    }
    // The second step: the new issue becomes the parent's last sub-issue. The issue is made
    // whatever this comes to; a failure comes back unapplied, to show on the new issue.
    if let Some(parent) = *parent {
        let adopt = Op::SubAdd {
            issue: parent,
            child: RelatedEnd {
                id: Some(id),
                owner: target.owner.clone(),
                repo: target.name.clone(),
                number: made.number,
            },
            replace_parent: false,
            after: None,
        };
        if let Err(f) = crate::relationship_writes::run(app, account, &adopt, sending).await {
            left.push(Unapplied {
                why: f.words(),
                ops: vec![adopt],
            });
        }
    }
    Ok(OpReply {
        issue: id,
        comment: None,
        body: None,
        refs: Refs::new(),
        unapplied: left,
    })
}

/// Issue `id` as a write's target: in the mirror, in a synced repo, an issue (not a PR), in a
/// repo this server writes to, and GitHub not down.
pub(crate) async fn writable(app: &App, account: i64, id: i64) -> Result<q::OpTargetRow, Failure> {
    let target = app
        .mirrors()
        .read(account, Caller::Request, move |c| q::op_target(c, id))
        .await
        .map_err(Failure::from)?
        .ok_or(Failure::Gone)?;
    if target.is_stub || !target.synced {
        return Err(Failure::Refused(
            "This issue is in a repo that isn't synced".into(),
        ));
    }
    if ItemKind::of(&target.kind)? != ItemKind::Issue {
        return Err(Failure::Refused(
            "beghu doesn't write to pull requests; open it on GitHub".into(),
        ));
    }
    read_only_here(app, &target.owner, &target.repo)?;
    if app.github().is_down() {
        return Err(Failure::GitHubDown(
            "GitHub is unreachable; try again once it's back".into(),
        ));
    }
    Ok(target)
}

/// Refuses a write to a repo this server doesn't write to: dev mode against real GitHub writes
/// only to the sandbox (`BEGHU_DEV_WRITABLE_REPOS`).
pub(crate) fn read_only_here(app: &App, owner: &str, repo: &str) -> Result<(), Failure> {
    if app.github().writes_to(owner, repo) {
        return Ok(());
    }
    let only = app.github().writable_repos().unwrap_or_default().join(", ");
    Err(Failure::Refused(format!(
        "This beghu writes only to {only}; {owner}/{repo} is read-only here"
    )))
}

/// The reply to a write that changed the issue itself: with `body`, a body edit's body as GitHub
/// has it, rendered as the detail will show it.
async fn edited(app: &App, account: i64, t: &q::OpTargetRow, body: Option<String>) -> OpReply {
    let (body, refs) = match body {
        Some(md) => {
            let (body, refs) = rendered_body(app, account, t, md).await;
            (Some(body), refs)
        }
        None => (None, Refs::new()),
    };
    OpReply {
        issue: t.id,
        comment: None,
        body,
        refs,
        unapplied: Vec::new(),
    }
}

/// GitHub's answer to one write, through the retry matrix.
pub(crate) async fn call(
    app: &App,
    account: i64,
    op: &Op,
    method: reqwest::Method,
    path: &str,
    body: &serde_json::Value,
    sending: &Sending,
) -> Result<serde_json::Value, Failure> {
    retrying(app, account, op, sending, |gh, token| {
        let method = method.clone();
        // With a token in hand: the call goes out now.
        sending.sent.store(true, Ordering::SeqCst);
        async move { gh.write(&token, method, path, body).await }
    })
    .await
}

/// What a title or body edit came to on GitHub.
enum Edited {
    /// The field was `base`: GitHub took the patch, and answered with this.
    Patched(serde_json::Value),
    /// The field was `new` already (an edit that reached GitHub, sent again): GitHub's title and
    /// body. Nothing was patched.
    Already((String, String)),
    /// The field was neither: GitHub's text of it. Nothing was patched.
    Changed(String),
}

/// A title or body edit's patch, made only while GitHub's field is still the edit's `base`: each
/// attempt, the first and each the retry matrix makes after a wait, [`check`]s the issue right
/// before it patches. The patch's answer, with its `ETag`, is kept as the next check's.
#[allow(clippy::too_many_arguments)]
async fn edit(
    app: &App,
    account: i64,
    t: &q::OpTargetRow,
    op: &Op,
    method: reqwest::Method,
    path: &str,
    body: &serde_json::Value,
    sending: &Sending,
) -> Result<Edited, Failure> {
    let (field, base, new) = op.edits().expect("a title or body edit");
    retrying(app, account, op, sending, |gh, token| {
        let method = method.clone();
        async move {
            let now = check(app, account, t, &gh, &token).await?;
            if same_text(field, field.of(&now), new) {
                return Ok(Edited::Already(now));
            }
            if !same_text(field, field.of(&now), base) {
                return Ok(Edited::Changed(field.of(&now).to_owned()));
            }
            // Checked: the patch goes out now.
            sending.sent.store(true, Ordering::SeqCst);
            let (answer, etag) = gh.write_tagged(&token, method, path, body).await?;
            if let (Some(etag), Ok(issue)) = (
                etag,
                serde_json::from_value::<webhook::Issue>(answer.clone()),
            ) {
                let text = (issue.title().to_owned(), issue.body().to_owned());
                app.ops().note_check(account, t.id, etag, text);
            }
            Ok(Edited::Patched(answer))
        }
    })
    .await
}

/// GitHub's title and body of the edit's issue now, asked with the `ETag` of the last check or
/// patch kept for it, so an unchanged issue is a free 304 and the kept text is current. A fresh
/// answer is kept for next time and written to the mirror (which pushes it to the tabs, so an
/// editor's "changed" notice and a 409's detail both show it).
async fn check(
    app: &App,
    account: i64,
    t: &q::OpTargetRow,
    gh: &github::GitHub,
    token: &str,
) -> Result<(String, String), github::Error> {
    let last = app.ops().last_check(account, t.id);
    let etag = last.as_ref().map(|c| c.etag.as_str());
    let issue = match gh
        .issue_if_changed(token, &t.owner, &t.repo, t.number, etag)
        .await?
    {
        github::Revalidated::NotModified => {
            return last
                .map(|c| c.text)
                .ok_or_else(|| github::Error::Malformed("a 304 to a read without an ETag".into()));
        }
        github::Revalidated::Fresh { etag, page } => (etag, page),
    };
    let (etag, issue) = issue;
    // The number names another issue now (a transfer and a new one in its place): not this one.
    if issue.id() != t.id {
        return Err(github::Error::Status(404));
    }
    let text = (issue.title().to_owned(), issue.body().to_owned());
    if let Some(etag) = etag {
        app.ops().note_check(account, t.id, etag, text.clone());
    }
    let repo = t.repo_id;
    store(app, account, t, move |tx, seq| {
        webhook::write_issue(tx, repo, &issue, seq)
    })
    .await;
    Ok(text)
}

/// A body GitHub took, rendered as the detail will show it, with the items in the mirror it refers
/// to (none if they can't be read now: the detail's refetch reads them again).
async fn rendered_body(app: &App, account: i64, t: &q::OpTargetRow, md: String) -> (Md, Refs) {
    let post = Post {
        kind: PostKind::Body,
        id: t.id,
        md,
    };
    let body = markdown::render(app, Place::from(t), vec![post])
        .await
        .remove(0)
        .md;
    let ask = body.clone();
    let refs = app
        .mirrors()
        .read(account, Caller::Request, move |c| markdown::refs(c, [&ask]))
        .await
        .unwrap_or_else(|e| {
            eprintln!(
                "ops: account {account}: the refs of issue {}'s body: {e}",
                t.id
            );
            Refs::new()
        });
    (body, refs)
}

/// One GitHub call of `op`'s, made by `make` with the user's token, through the retry matrix: a
/// short rate limit waited out, a 5xx, timeout or reset tried again (but never a comment's), and
/// each refusal as the failure it is.
async fn retrying<T, F, Fut>(
    app: &App,
    account: i64,
    op: &Op,
    sending: &Sending,
    make: F,
) -> Result<T, Failure>
where
    F: Fn(github::GitHub, String) -> Fut,
    Fut: std::future::Future<Output = Result<T, github::Error>>,
{
    let mut retries = if op.retries() { &RETRIES[..] } else { &[] }.iter();
    let mut quiet_waits = 0;
    loop {
        let gh = app.github().clone();
        let answer = app
            .tokens()
            .with_token(account, |token| make(gh.clone(), token))
            .await;
        let e = match answer {
            Ok(v) => return Ok(v),
            Err(tokens::Error::GitHub(e)) => e,
            Err(tokens::Error::SignInAgain) => return Err(Failure::SignedOut),
            Err(tokens::Error::Restarting) => return Err(Failure::Restarting),
            // Only before a call, or after a 401 (GitHub took nothing): the write wasn't made.
            Err(e) => return Err(Failure::Internal(e.to_string())),
        };
        match e {
            github::Error::RateLimited(wait) if wait <= QUIET_WAIT && quiet_waits < QUIET_WAITS => {
                quiet_waits += 1;
                tokio::time::sleep(wait).await;
            }
            github::Error::RateLimited(wait) => return Err(Failure::RateLimited(wait)),
            github::Error::Unsent(_)
            | github::Error::Network(_)
            | github::Error::Status(500..=599) => {
                // A comment or new issue GitHub may have got is never sent again (see
                // [`Op::retries`]).
                let reached = !matches!(e, github::Error::Unsent(_));
                if let Some(f) = sending.unsure().filter(|_| reached) {
                    return Err(f);
                }
                match retries.next() {
                    Some(wait) => tokio::time::sleep(*wait).await,
                    // Tried again and again: GitHub kept failing.
                    None if op.retries() => {
                        return Err(Failure::GitHubDown(
                            "GitHub kept failing on this change; try again".into(),
                        ));
                    }
                    // Tried once, and never sent: one sent is unsure, above.
                    None => {
                        return Err(Failure::GitHubDown(
                            "Couldn't reach GitHub, so it wasn't sent; try again".into(),
                        ));
                    }
                }
            }
            // A 401 with the token the refresh brought: the grant is gone.
            github::Error::Unauthorized => return Err(Failure::SignedOut),
            github::Error::Status(403) => return Err(Failure::Forbidden),
            // A label the issue doesn't have; any other 404 is out of sight.
            github::Error::NoSuchLabel if matches!(op, Op::LabelRemove { .. }) => {
                return Err(Failure::NoSuchLabel);
            }
            // 301: transferred since, and its webhooks not yet here (redirects aren't
            // followed): the issue is somewhere else now, as for the 404 and 410.
            github::Error::NoSuchLabel | github::Error::Status(301 | 404 | 410) => {
                return Err(Failure::Gone);
            }
            github::Error::Status(409) => {
                return Err(Failure::Conflict(
                    "GitHub reported a conflict; try again".into(),
                ));
            }
            github::Error::Status(422) => {
                return Err(Failure::Refused("GitHub couldn't apply this change".into()));
            }
            github::Error::Unprocessable(m) => return Err(Failure::Unprocessable(m)),
            // A 2xx beghu couldn't read: GitHub made the write.
            e @ github::Error::Malformed(_) => {
                if let Some(f) = sending.unsure() {
                    return Err(f);
                }
                return Err(Failure::Internal(e.to_string()));
            }
            e => return Err(Failure::Internal(e.to_string())),
        }
    }
}

/// The repo an op's issue is in, and whether the account opened the issue.
#[derive(Clone)]
pub(crate) struct IssueRepo {
    pub(crate) repo_id: i64,
    pub(crate) owner: String,
    pub(crate) repo: String,
    pub(crate) own: bool,
}

/// Whether `role` allows `op` on an issue the account opened (`own`) or not: anyone can
/// comment; Triage and up close and reopen any issue, Read only its own; labels, assignees and
/// the milestone take Triage, even on the account's own issue.
///
/// The roles rule module (#106) takes this over, with the archived and locked flags.
fn allows(role: Role, op: &Op, own: bool) -> bool {
    match op {
        Op::Comment { .. } => true,
        // Anyone who sees the repo opens an issue; its labels, assignees and milestone are each
        // their own write's question.
        Op::Create { .. } => true,
        Op::Close { .. } | Op::Reopen { .. } => own || role >= Role::Triage,
        Op::LabelAdd { .. }
        | Op::LabelRemove { .. }
        | Op::AssigneeAdd { .. }
        | Op::AssigneeRemove { .. }
        | Op::MilestoneSet { .. } => role >= Role::Triage,
        Op::TitleEdit { .. } | Op::BodyEdit { .. } => own || role >= Role::Write,
        // Authorship gives no relationship rights (verified live).
        Op::SubAdd { .. }
        | Op::SubRemove { .. }
        | Op::SubReorder { .. }
        | Op::BlockAdd { .. }
        | Op::BlockRemove { .. }
        | Op::RelateAdd { .. }
        | Op::RelateRemove { .. } => role >= Role::Triage,
    }
}

/// Why GitHub refused `op`, or answered it without applying it, in terms of the account's role
/// on the repo, re-read from GitHub at once and stored for the next write and the next
/// `/api/me`. Only the wait for it is bounded (by [`REREAD_WAIT`]): a slower re-read is still
/// stored when it comes. Just the reason: the tab says what couldn't be done.
pub(crate) async fn refused_why(app: &App, account: i64, at: &IssueRepo, op: &Op) -> String {
    // The repo by its bare name, as the user knows it.
    let repo = &at.repo;
    let reread = {
        let at = at.clone();
        app.spawn(move |app| async move { reread_role(&app, account, &at).await })
    };
    let unknown = || format!("your role on {repo} may not allow it");
    match tokio::time::timeout(REREAD_WAIT, reread).await {
        Ok(Ok(Some(Ok(Access::Role(role))))) if allows(role, op, at.own) => {
            "GitHub didn't apply this change".into()
        }
        Ok(Ok(Some(Ok(Access::Role(role))))) => match op {
            Op::Close { .. } | Op::Reopen { .. } => format!(
                "you have {} on {repo}, which closes or reopens only issues you opened",
                role.name()
            ),
            Op::TitleEdit { .. } | Op::BodyEdit { .. } => format!(
                "you have {} on {repo}, which edits only issues you opened",
                role.name()
            ),
            _ => format!("you have {} on {repo}", role.name()),
        },
        Ok(Ok(Some(Ok(Access::None)))) => format!("you no longer have access to {repo}"),
        Ok(Ok(Some(Ok(Access::Unknown)))) | Ok(Ok(None)) => unknown(),
        Ok(Ok(Some(Err(e)))) => {
            eprintln!("ops: account {account}: re-reading the role on {repo}: {e}");
            unknown()
        }
        Ok(Err(e)) => {
            eprintln!("ops: account {account}: re-reading the role on {repo} panicked: {e}");
            unknown()
        }
        Err(_) => unknown(),
    }
}

/// The account's access to `at`'s repo, from GitHub now; a known role is written to the
/// mirror. With no access, a full re-read of its repos follows, to stop syncing the repo.
async fn reread_role(app: &App, account: i64, at: &IssueRepo) -> Result<Access, String> {
    let gh = app.github().clone();
    let access = app
        .tokens()
        .with_token(account, |token| {
            let gh = gh.clone();
            async move { gh.repo_access(&token, &at.owner, &at.repo).await }
        })
        .await
        .map_err(|e| e.to_string())?;
    match access {
        Access::None => {
            app.spawn(move |app| async move { repos::refresh_roles_now(&app, account).await });
        }
        Access::Unknown => {}
        Access::Role(role) => {
            let id = at.repo_id;
            app.mirrors()
                .write(account, Caller::Request, move |tx, _| {
                    q::set_repo_role(tx, id, role.as_str())
                })
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(access)
}

/// `s` as one segment of a URL path: everything but unreserved characters percent-encoded, so a
/// label called `needs review/ui` stays one segment.
fn path_segment(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Reads the op's issue from GitHub with the user's token and writes it as GitHub has it. A
/// failure is logged, not failed: GitHub has the change, and the mirror has it too.
async fn read_back(app: &App, account: i64, t: &q::OpTargetRow) {
    let gh = app.github().clone();
    let read = app
        .tokens()
        .with_token(account, |token| {
            let (gh, owner, repo) = (gh.clone(), t.owner.clone(), t.repo.clone());
            let number = t.number;
            async move { gh.issue(&token, &owner, &repo, number).await }
        })
        .await;
    let (id, repo) = (t.id, t.repo_id);
    match read {
        Ok(Shown::It(issue)) if issue.id() == id => {
            store(app, account, t, move |tx, seq| {
                webhook::write_issue(tx, repo, &issue, seq)
            })
            .await;
        }
        Ok(Shown::Moved) => eprintln!("ops: account {account}: issue {id} was transferred"),
        Ok(_) => eprintln!("ops: account {account}: issue {id} is gone from GitHub"),
        Err(e) => eprintln!("ops: account {account}: reading issue {id} back: {e}"),
    }
}

/// Writes GitHub's answer to the mirror and pushes the issue's id if a row changed. An answer
/// that overwrote a row of its own second saying otherwise has the issue read again once the
/// second has settled (see `webhook::write_issue`). A failed write is logged, not failed: GitHub
/// has the change, and its webhook brings it to the mirror.
async fn store<F, R>(app: &App, account: i64, t: &q::OpTargetRow, write: F)
where
    F: FnOnce(&rusqlite::Transaction, i64) -> rusqlite::Result<R> + Send + 'static,
    R: Into<webhook::Wrote> + Send + 'static,
{
    let id = t.id;
    let wrote = app
        .mirrors()
        .write(account, Caller::Request, move |tx, seq| {
            write(tx, seq).map(Into::into)
        })
        .await;
    let w: webhook::Wrote = match wrote {
        Ok(w) => w,
        Err(e) => {
            eprintln!("ops: account {account}: writing issue {id} to the mirror: {e}");
            return;
        }
    };
    if w.changed {
        app.hub().publish(account, Push::Ids(Arc::from([id])));
    }
    if !w.reread {
        return;
    }
    match t.installation_id {
        Some(installation) => drop(app.edges().schedule(
            Subject {
                id,
                node_id: t.node_id.clone(),
                number: t.number,
                repo: t.repo_id,
                installation,
            },
            ReadBack::Issue,
            false,
        )),
        None => eprintln!(
            "ops: account {account}: issue {id}'s repo names no installation; it can't be read again"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{Failure, OpKind};
    use crate::error::ApiError;
    use std::time::Duration;

    /// A mirror at its connection cap, or still migrating, fails a write's read as the routes
    /// do: 503 with `retry-after`, for the tab to try again, not an internal error.
    #[test]
    fn a_mirror_saying_try_again_later_is_a_503_with_retry_after() {
        let e = dbrt::Error::Unavailable {
            retry_after: Duration::from_secs(3),
            reason: dbrt::Unavailable::AtCapacity,
        };
        match ApiError::from(Failure::from(e)) {
            ApiError::Unavailable { retry_after, .. } => {
                assert_eq!(retry_after, Duration::from_secs(3));
            }
            other => panic!("not a 503: {other:?}"),
        }
    }

    /// Writes `lostMessage.ts` beside ts-rs's bindings (`TS_RS_EXPORT_DIR`): the words of a lost
    /// write, for the tab's own.
    #[test]
    fn export_lost_message() {
        let dir = std::env::var("TS_RS_EXPORT_DIR").expect("TS_RS_EXPORT_DIR (.cargo/config.toml)");
        let entries = [
            ("comment", OpKind::Comment),
            ("close", OpKind::Close),
            ("reopen", OpKind::Reopen),
            ("label_add", OpKind::LabelAdd),
            ("label_remove", OpKind::LabelRemove),
            ("assignee_add", OpKind::AssigneeAdd),
            ("assignee_remove", OpKind::AssigneeRemove),
            ("milestone_set", OpKind::MilestoneSet),
            ("title_edit", OpKind::TitleEdit),
            ("body_edit", OpKind::BodyEdit),
            ("create", OpKind::Create),
            ("sub_add", OpKind::SubAdd),
            ("sub_remove", OpKind::SubRemove),
            ("sub_reorder", OpKind::SubReorder),
            ("block_add", OpKind::BlockAdd),
            ("block_remove", OpKind::BlockRemove),
            ("relate_add", OpKind::RelateAdd),
            ("relate_remove", OpKind::RelateRemove),
        ]
        .map(|(name, kind)| {
            let words = serde_json::to_string(kind.lost_message()).unwrap();
            format!("  {name}: {words},\n")
        });
        let ts = format!(
            "// Generated by `cargo test` from `OpKind::lost_message` (crates/server/src/ops.rs). Do not edit.\n\
             import type {{ Op }} from \"./Op\";\n\n\
             /** What a lost write says, by what it was. */\n\
             export const LOST_MESSAGE: Record<Op[\"kind\"], string> = {{\n{}}};\n",
            entries.concat()
        );
        std::fs::write(std::path::Path::new(&dir).join("lostMessage.ts"), ts).unwrap();
    }
}
