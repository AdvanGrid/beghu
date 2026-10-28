//! Startup step 6: the migration walker. After a deploy with a new in-place mirror migration, it
//! brings the active accounts' mirrors up to the build in the background, one at a time, the
//! most recently used first, so an account's next use seldom waits on "Updating mirror…". It's
//! low priority: it migrates as an account's first use would (the same job, behind the same
//! gate, so a request arriving meanwhile waits for that one migration), but waits for a place
//! under the connection cap rather than take one from a request, and only one mirror is ever
//! its own. It passes by a mirror whose migration fails (the failure stands for everyone, as
//! after a first use), and leaves alone one a `.rebuild.sql` migration would replace, or that has
//! no file: rebuilding re-imports from GitHub, which waits for the account's first use. A mirror
//! it hasn't reached still migrates on its first use. Dormant accounts have no mirror, and
//! accounts that must sign in again have theirs deleted, so neither is walked.

use crate::App;
use mirror_db::CatchUp;

/// Walks the active accounts' mirrors once, the most recently used first. A job: the drain stops
/// it between two mirrors (a migration under way is the database runtime's, and finishes).
pub async fn walk(app: App) {
    let order = match app.control().read(control_db::q::walk_order).await {
        Ok(o) => o,
        Err(e) => {
            eprintln!(
                "migration walker: can't read the active accounts ({e}); each mirror migrates on its first use"
            );
            return;
        }
    };
    let (mut ready, mut left) = (0, 0);
    for account in order {
        match app.mirrors().catch_up(account).await {
            Ok(CatchUp::Ready) => ready += 1,
            Ok(CatchUp::LeftForFirstUse) => left += 1,
            Err(e) => eprintln!("migration walker: account {account}'s mirror: {e}; passed by"),
        }
    }
    eprintln!(
        "migration walker: done; {ready} mirrors at this build's version, {left} left for their first use"
    );
}
