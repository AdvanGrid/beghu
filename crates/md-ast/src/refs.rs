//! References in running text, as GitHub autolinks them: `#n` (an issue in the post's own repo),
//! `owner/repo#n`, `@user` and `@org/team`. Text inside links and code never gets here.
//!
//! Mentions follow GitHub's MentionFilter and TeamMentionFilter (html-pipeline; their patterns
//! are in docs/research/markdown-rendering.md, §2): `@org/team` is a team, written as GitHub
//! would link it whether or not the team exists, and the `@org` in it is never a user.

/// One reference found in a text.
#[derive(Debug, PartialEq)]
pub(crate) enum Found<'t> {
    /// `#n`, or `owner/repo#n` when `repo` is set.
    Issue {
        repo: Option<(&'t str, &'t str)>,
        number: i64,
    },
    User(&'t str),
    /// `org/team`.
    Team(&'t str),
}

/// The largest issue number that's a reference: the largest a browser holds exactly (JavaScript's
/// `Number.MAX_SAFE_INTEGER`).
pub(crate) const MAX_NUMBER: i64 = (1 << 53) - 1;

/// A letter, digit or underscore: what may not touch a reference on either side.
fn word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// A login's characters, besides the underscore of an Enterprise Managed User's.
fn login_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-'
}

/// The longest a login is.
const MAX_LOGIN: usize = 39;

/// How long the login at the start of `b` is, or 0: a letter or digit, then letters, digits and
/// hyphens, not ending with a hyphen. GitHub's pattern takes every hyphen there is (an atomic
/// group), so a run that ends with one is no login, not a shorter login: `@ilze-` isn't `@ilze`.
/// An Enterprise Managed User's login adds an underscore and its enterprise's shortcode, 3 to 8
/// letters and digits (GitHub's `handle_shortcode`); an underscore anywhere else ends the login
/// with a word character after it, which is no login.
fn login_len(b: &[u8]) -> usize {
    if !b.first().is_some_and(u8::is_ascii_alphanumeric) {
        return 0;
    }
    let mut end = b.iter().take_while(|c| login_char(**c)).count();
    if b[end - 1] == b'-' {
        return 0;
    }
    if b.get(end) == Some(&b'_') {
        let code = b[end + 1..]
            .iter()
            .take_while(|c| c.is_ascii_alphanumeric())
            .count();
        if (3..=8).contains(&code) && b.get(end + 1 + code) != Some(&b'_') {
            end += 1 + code;
        }
    }
    end
}

/// A repo name's characters.
fn repo_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')
}

/// The char before byte `at`, if any.
fn before(s: &str, at: usize) -> Option<char> {
    s[..at].chars().next_back()
}

/// The issue reference whose `#` is at byte `at`: its start and end, and what it names.
fn issue_at(s: &str, at: usize) -> Option<(usize, usize, Found<'_>)> {
    let b = s.as_bytes();
    let digits = b[at + 1..]
        .iter()
        .take_while(|c| c.is_ascii_digit())
        .count();
    let end = at + 1 + digits;
    if digits == 0 || s[end..].chars().next().is_some_and(word) {
        return None;
    }
    let number: i64 = s[at + 1..end]
        .parse()
        .ok()
        .filter(|n| (1..=MAX_NUMBER).contains(n))?;
    // `owner/repo` right before the `#`?
    let repo_start = at - b[..at].iter().rev().take_while(|c| repo_char(**c)).count();
    if repo_start < at && repo_start > 0 && b[repo_start - 1] == b'/' {
        let slash = repo_start - 1;
        let owner_start = slash
            - b[..slash]
                .iter()
                .rev()
                .take_while(|c| login_char(**c) || **c == b'_')
                .count();
        let clear = before(s, owner_start).is_none_or(|c| !word(c) && !"/.-@".contains(c));
        // The owner is a whole login: `-x/y#1` is no reference at all.
        if owner_start < slash && clear && login_len(&b[owner_start..slash]) == slash - owner_start
        {
            let repo = (&s[owner_start..slash], &s[repo_start..at]);
            return Some((
                owner_start,
                end,
                Found::Issue {
                    repo: Some(repo),
                    number,
                },
            ));
        }
        return None;
    }
    // A bare `#n` stands alone: not inside a word, an entity (`&#12;`) or a path.
    let clear = before(s, at).is_none_or(|c| !word(c) && !"&#/.-".contains(c));
    clear.then_some((at, end, Found::Issue { repo: None, number }))
}

/// The mention whose `@` is at byte `at`: its start and end, and who it names.
fn mention_at(s: &str, at: usize) -> Option<(usize, usize, Found<'_>)> {
    if before(s, at).is_some_and(|c| word(c) || "/@.`-".contains(c)) {
        return None;
    }
    let b = s.as_bytes();
    let first = at + 1;
    let end = first + login_len(&b[first..]);
    if end == first || end - first > MAX_LOGIN {
        return None;
    }
    if b.get(end) == Some(&b'/') {
        // A team, or nothing: an organisation's login has no underscore, and a team's name is a
        // letter or digit, then letters, digits, hyphens and underscores, to a word's end.
        let org = &b[first..end];
        let name = &b[end + 1..];
        if org.contains(&b'_') || !name.first().is_some_and(u8::is_ascii_alphanumeric) {
            return None;
        }
        let mut len = name
            .iter()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            .count();
        // Unlike a login, a team's name gives back trailing hyphens: its pattern backtracks to
        // the word's end (`\b`), so `@org/team-` is `@org/team`.
        while name[len - 1] == b'-' {
            len -= 1;
        }
        let team_end = end + 1 + len;
        if s[team_end..].chars().next().is_some_and(word) {
            return None;
        }
        return Some((at, team_end, Found::Team(&s[first..team_end])));
    }
    // Dots may follow, then no word: `@ilze.` is `@ilze`, and `@ilze.k` nobody.
    let dots = b[end..].iter().take_while(|c| **c == b'.').count();
    if s[end + dots..].chars().next().is_some_and(word) {
        return None;
    }
    Some((at, end, Found::User(&s[first..end])))
}

/// Every reference in `s`, with its byte span, in order.
pub(crate) fn scan(s: &str) -> Vec<(usize, usize, Found<'_>)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(off) = s[from..].find(['#', '@']) {
        let at = from + off;
        let hit = if s.as_bytes()[at] == b'#' {
            issue_at(s, at)
        } else {
            mention_at(s, at)
        };
        match hit {
            // An `owner/repo#n` starts before text already passed over as plain: still its own.
            Some((start, end, found)) if start >= out.last().map_or(0, |l: &(_, usize, _)| l.1) => {
                out.push((start, end, found));
                from = end;
            }
            _ => from = at + 1,
        }
    }
    out
}
