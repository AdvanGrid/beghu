//! Account preferences: comment order and the keymap, stored per connected account in the
//! control DB's `preferences` row, so they follow the account to every browser. (Device
//! preferences, such as the theme and the widths, stay in the browser.)
//!
//! - `GET /api/me` carries them (`comment_order`, and `keymap`: the account's own bindings, by
//!   action), so a tab applies them before anything shows.
//! - `PATCH /api/prefs` sets one field per call, and the last write wins. A key change names its
//!   action and its bindings (one per line), `""` for none, `null` back to the preset's.
//! - Each change is pushed to the account's tabs as `prefs` (live.rs), which read `/api/me` again.
//!
//! The server applies comment order (detail.rs). The keymap it only keeps: the preset, and which
//! keys a browser refuses, are the web app's (web/src/keys.ts), which also resolves a preset key
//! an account gave to another action (that action keeps it).

use crate::App;
use crate::api::CommentOrder;
use crate::auth::Session;
use crate::error::ApiError;
use crate::live::Push;
use axum::Json;
use axum::extract::{Extension, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// Every key action, as the web app names it (web/src/keys.ts, `ACTIONS`), each with its column
/// in `preferences` (control-db's migrations and `queries/preferences.sql`).
macro_rules! actions {
    ($($variant:ident = $name:literal),* $(,)?) => {
        /// A key action: something the keymap binds keys to.
        #[derive(Serialize, Deserialize, TS, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
        #[ts(export)]
        pub enum KeyAction {
            $(#[serde(rename = $name)] $variant,)*
        }

        impl KeyAction {
            /// The action's name, as on the wire and in the DB's queries.
            pub fn name(self) -> &'static str {
                match self {
                    $(KeyAction::$variant => $name,)*
                }
            }

            /// The action of this name; `None` for one this build doesn't know.
            pub fn named(name: &str) -> Option<KeyAction> {
                match name {
                    $($name => Some(KeyAction::$variant),)*
                    _ => None,
                }
            }
        }
    };
}

actions! {
    Next = "next",
    Previous = "previous",
    First = "first",
    Last = "last",
    OpenIssue = "openIssue",
    ToList = "toList",
    FocusFilter = "focusFilter",
    Create = "create",
    ToggleMode = "toggleMode",
    Labels = "labels",
    Assignees = "assignees",
    Milestone = "milestone",
    BlockedBy = "blockedBy",
    Blocking = "blocking",
    RelatesTo = "relatesTo",
    Comment = "comment",
    EditTitle = "editTitle",
    CloseReopen = "closeReopen",
    Send = "send",
    SaveEdit = "saveEdit",
    CancelEdit = "cancelEdit",
    ImageOpen = "imageOpen",
    ImageClose = "imageClose",
    Help = "help",
}

/// An account's own bindings, by action: each action's bindings, one per line, `""` for one left
/// unbound. An action left out has the preset's.
pub type Keymap = BTreeMap<KeyAction, String>;

/// The longest bindings text one action takes: far more than a handful of chords.
const BINDINGS_MAX: usize = 200;

/// One change: `PATCH /api/prefs`'s body.
#[derive(Deserialize, TS)]
#[ts(export)]
#[serde(tag = "field", rename_all = "snake_case")]
pub enum PrefChange {
    /// The thread's order in the detail.
    CommentOrder { value: CommentOrder },
    /// One action's bindings: one per line; `""` unbinds it, `null` puts the preset's back.
    Key {
        action: KeyAction,
        binding: Option<String>,
    },
}

/// The account's own bindings, as `/api/me` carries them. One this build doesn't know (a newer
/// build's) is left out: a preference never fails a read.
pub fn keymap(rows: Vec<control_db::q::KeyBindingsRow>) -> Keymap {
    rows.into_iter()
        .filter_map(|r| Some((KeyAction::named(&r.action)?, r.binding)))
        .collect()
}

/// `PATCH /api/prefs`: sets one field of the account's preferences, then tells its tabs.
pub async fn patch(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Json(change): Json<PrefChange>,
) -> Result<StatusCode, ApiError> {
    let account = s.account;
    match change {
        PrefChange::CommentOrder { value } => {
            app.control()
                .write(move |tx| control_db::q::set_comment_order(tx, account, Some(value.name())))
                .await?;
        }
        PrefChange::Key { action, binding } => {
            if let Some(b) = &binding {
                if b.len() > BINDINGS_MAX {
                    return Err(ApiError::BadRequest(format!(
                        "an action's bindings take at most {BINDINGS_MAX} bytes"
                    )));
                }
                if b.chars().any(|c| c.is_control() && c != '\n') {
                    return Err(ApiError::BadRequest(
                        "bindings are one per line, with no other control characters".into(),
                    ));
                }
            }
            let stored = app
                .control()
                .write(move |tx| {
                    control_db::q::ensure_preferences(tx, account)?;
                    control_db::q::set_key(tx, account, action.name(), binding.as_deref())
                })
                .await?;
            // An action `set_key` has no column for: a new one whose migration or query arm is
            // missing. Said, rather than answered as stored.
            if stored == 0 {
                return Err(ApiError::Internal(format!(
                    "the key action {} has no column to store it in",
                    action.name()
                )));
            }
        }
    }
    app.hub().publish(account, Push::Prefs);
    Ok(StatusCode::NO_CONTENT)
}
