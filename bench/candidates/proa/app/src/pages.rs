//! Server-rendered pages. Every page is plain Proa SSR; the browser keeps them live with Turbo
//! Drive (filters are links, search is a GET form), lazy Turbo Frames (paging) and a Turbo Stream
//! source that asks for a morphing refresh when the mirror changes.
use proa_core::{DataLoader, WebContext, WebRenderSync, WriteError};
use proa_macros::html_sync;

use crate::db::{Comment, Facets, IssueRow, ListQuery};
use crate::search::SearchBox;


fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The query string for a view, without offset.
fn query_string(q: &ListQuery) -> String {
    let mut parts = vec![];
    if q.state.as_deref() == Some("closed") {
        parts.push("state=closed".to_string());
    }
    for l in &q.label {
        parts.push(format!("label={}", encode(l)));
    }
    for a in &q.assignee {
        parts.push(format!("assignee={}", encode(a)));
    }
    if let Some(text) = q.q.as_ref().filter(|t| !t.is_empty()) {
        parts.push(format!("q={}", encode(text)));
    }
    parts.join("&")
}

fn href(q: &ListQuery) -> String {
    let qs = query_string(q);
    if qs.is_empty() { "/".into() } else { format!("/?{qs}") }
}

fn toggled(list: &[String], value: &str) -> Vec<String> {
    if list.iter().any(|v| v == value) {
        list.iter().filter(|v| *v != value).cloned().collect()
    } else {
        let mut next = list.to_vec();
        next.push(value.to_string());
        next
    }
}

fn pressed(on: bool) -> &'static str {
    if on { "true" } else { "false" }
}

pub struct Row<'a> {
    pub row: &'a IssueRow,
}

impl<L: DataLoader> WebRenderSync<L> for Row<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        let r = self.row;
        let link = format!("/issues/{}", r.id);
        let id = r.id.to_string();
        let meta = format!("{}#{} · {} comments", r.repo, r.number, r.comments_count);
        html_sync! {
            <a class="row" href={link.as_str()} data-turbo-frame="_top" data-bench="row" data-id={id.as_str()}>
                <span class="title" data-bench="title">{r.title.as_str()}</span>
                <span class="meta">{meta.as_str()}</span>
                <span class="chips">
                    {for l in &r.labels {
                        html_sync! { <span class="chip">{l.name.as_str()}</span> }
                    }}
                </span>
                <span class="who">
                    {for a in &r.assignees {
                        html_sync! { <span>{a.as_str()}</span> }
                    }}
                </span>
            </a>
        }
        .render(cx)
    }
}

/// Rows from `offset`, then a lazy frame for the next page when this one was full.
pub struct Rows<'a> {
    pub q: &'a ListQuery,
    pub offset: i64,
    pub rows: &'a [IssueRow],
}

impl<L: DataLoader> WebRenderSync<L> for Rows<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        let page = crate::opts::OPTS.page;
        let next = self.offset + page;
        let more = self.rows.len() as i64 == page;
        let frame = format!("p{next}");
        let qs = query_string(self.q);
        let src = if qs.is_empty() { format!("/rows?offset={next}") } else { format!("/rows?{qs}&offset={next}") };
        html_sync! {
            {for row in self.rows {
                html_sync! { {Row { row }} }
            }}
            {if more {
                html_sync! { <turbo-frame id={frame.as_str()} src={src.as_str()} loading="lazy" target="_top"></turbo-frame> }
            }}
        }
        .render(cx)
    }
}

/// The response to a lazy page request: the frame it replaces, holding the rows.
pub struct RowsFrame {
    pub q: ListQuery,
    pub offset: i64,
    pub rows: Vec<IssueRow>,
}

impl<L: DataLoader> WebRenderSync<L> for RowsFrame {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        let frame = format!("p{}", self.offset);
        html_sync! {
            <turbo-frame id={frame.as_str()} target="_top">
                {Rows { q: &self.q, offset: self.offset, rows: &self.rows }}
            </turbo-frame>
        }
        .render(cx)
    }
}

pub struct ListPage {
    pub facets: std::sync::Arc<Facets>,
    pub q: ListQuery,
    pub rows: Vec<IssueRow>,
}

impl<L: DataLoader> WebRenderSync<L> for ListPage {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        let search = self.q.q.clone().unwrap_or_default();
        let view = View { facets: &self.facets, q: &self.q, rows: &self.rows };
        if crate::opts::OPTS.frame {
            // The search box stays outside the frame, so a visit never moves or morphs it.
            html_sync! {
                <main class="app">
                    <div class="filters">{SearchBox { q: search }}</div>
                    <turbo-frame id="view" data-turbo-action="advance">{view}</turbo-frame>
                </main>
            }
            .render(cx)
        } else {
            html_sync! {
                <main class="app">
                    <div id="search" class="filters" data-turbo-permanent>{SearchBox { q: search }}</div>
                    {view}
                </main>
            }
            .render(cx)
        }
    }
}

/// The filters (as links, plus the hidden inputs the search form submits) and the list.
pub struct View<'a> {
    pub facets: &'a Facets,
    pub q: &'a ListQuery,
    pub rows: &'a [IssueRow],
}

impl<L: DataLoader> WebRenderSync<L> for View<'_> {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        let q = self.q;
        let action = crate::opts::OPTS.filter_action;
        let closed = q.state.as_deref() == Some("closed");
        let open_href = href(&ListQuery { state: None, ..q.clone() });
        let closed_href = href(&ListQuery { state: Some("closed".into()), ..q.clone() });
        let labels: Vec<(String, String, bool)> = self
            .facets
            .labels
            .iter()
            .map(|l| (l.clone(), href(&ListQuery { label: toggled(&q.label, l), ..q.clone() }), q.label.contains(l)))
            .collect();
        let assignees: Vec<(String, String, bool)> = self
            .facets
            .assignees
            .iter()
            .map(|a| (a.clone(), href(&ListQuery { assignee: toggled(&q.assignee, a), ..q.clone() }), q.assignee.contains(a)))
            .collect();
        let empty = self.rows.is_empty();
        html_sync! {
            <div>
                <header class="filters">
                    {if closed {
                        html_sync! { <input type="hidden" form="search-form" name="state" value="closed" /> }
                    }}
                    {for (name, _, on) in &labels {
                        html_sync! {
                            {if *on {
                                html_sync! { <input type="hidden" form="search-form" name="label" value={name.as_str()} /> }
                            }}
                        }
                    }}
                    {for (name, _, on) in &assignees {
                        html_sync! {
                            {if *on {
                                html_sync! { <input type="hidden" form="search-form" name="assignee" value={name.as_str()} /> }
                            }}
                        }
                    }}
                    <nav class="group">
                        <a class="toggle" href={open_href.as_str()} data-bench="filter-state" data-value="open" aria-pressed={pressed(!closed)} data-turbo-action={action}>"Open"</a>
                        <a class="toggle" href={closed_href.as_str()} data-bench="filter-state" data-value="closed" aria-pressed={pressed(closed)} data-turbo-action={action}>"Closed"</a>
                    </nav>
                    <nav class="group">
                        {for (name, link, on) in &labels {
                            html_sync! {
                                <a class="toggle" href={link.as_str()} data-bench="filter-label" data-value={name.as_str()} aria-pressed={pressed(*on)} data-turbo-action={action}>{name.as_str()}</a>
                            }
                        }}
                    </nav>
                    <nav class="group">
                        {for (name, link, on) in &assignees {
                            html_sync! {
                                <a class="toggle" href={link.as_str()} data-bench="filter-assignee" data-value={name.as_str()} aria-pressed={pressed(*on)} data-turbo-action={action}>{name.as_str()}</a>
                            }
                        }}
                    </nav>
                </header>
                {if empty {
                    html_sync! { <section class="list" data-bench="list" data-bench-empty>"No issues match."</section> }
                } else {
                    html_sync! {
                        <section class="list" data-bench="list">
                            {Rows { q, offset: 0, rows: self.rows }}
                        </section>
                    }
                }}
            </div>
        }
        .render(cx)
    }
}

/// The detail's static parts: title line, body, comments.
pub struct DetailHead {
    pub title: String,
    pub heading: String,
}

impl<L: DataLoader> WebRenderSync<L> for DetailHead {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        html_sync! {
            <header>
                <p><a href="/">"← Issues"</a></p>
                <h1>{self.title.as_str()}</h1>
                <p class="meta">{self.heading.as_str()}</p>
            </header>
        }
        .render(cx)
    }
}

pub struct DetailBody {
    pub body: String,
    pub comments: Vec<Comment>,
}

impl<L: DataLoader> WebRenderSync<L> for DetailBody {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        html_sync! {
            <div>
                <article class="body" data-bench="body">{self.body.as_str()}</article>
                <ol class="comments">
                    {for c in &self.comments {
                        html_sync! {
                            <li class="comment" data-bench="comment">
                                <p class="meta">{c.author.as_deref().unwrap_or("ghost")}" · "{c.created_at.as_str()}</p>
                                <div class="body">{c.body.as_str()}</div>
                            </li>
                        }
                    }}
                </ol>
            </div>
        }
        .render(cx)
    }
}
