//! The async shell: the document and the detail page, which holds the async label island.
use std::future::Future;

use proa_core::{raw_text_ok, to_async, DataLoader, RenderOutcome, WebContext, WebRender, WriteError};
use proa_macros::html;

use crate::db::IssueDetail;
use crate::labels::{AddLabels, LabelOption};
use crate::pages::{DetailBody, DetailHead};

/// Every island's runtime and modules, preloaded on every page so an island that arrives with a
/// Turbo visit (the detail's label editor) is already in the module map when its HTML lands.
pub fn module_preloads() -> Vec<String> {
    let manifest = rsjs::manifest();
    let ids: Vec<&'static str> = manifest.islands.iter().map(|i| i.asset_id).collect();
    let plan = manifest.page_runtime_plan(ids).expect("every island resolves in the linked manifest");
    let mut urls = vec![];
    if let Some(rt) = &plan.runtime {
        urls.push(rt.base.clone());
        urls.extend(rt.query.clone());
    }
    urls.extend(plan.eager_islands.iter().map(|i| i.module_url.clone()));
    urls.extend(plan.module_preloads.iter().cloned());
    urls.sort();
    urls.dedup();
    urls
}

static PRELOADS: std::sync::LazyLock<Vec<String>> = std::sync::LazyLock::new(|| if crate::opts::OPTS.preload { module_preloads() } else { vec![] });

pub struct Document<C> {
    pub title: String,
    pub content: C,
}

impl<L, C> WebRender<L> for Document<C>
where
    L: DataLoader,
    C: WebRender<L> + Send + 'static,
{
    fn render(self, cx: &mut WebContext<L>) -> RenderOutcome<impl Future<Output = Result<(), WriteError>>> {
        RenderOutcome::pending(async move {
            let Document { title, content } = self;
            html! {
                <!DOCTYPE html>
                <html lang="en">
                    <head>
                        <meta charset="utf-8" />
                        <meta name="viewport" content="width=device-width, initial-scale=1" />
                        <meta name="color-scheme" content="light dark" />
                        <meta name="turbo-refresh-method" content="morph" />
                        <meta name="turbo-refresh-scroll" content="preserve" />
                        {if crate::opts::OPTS.no_snapshot_cache {
                            html! { <meta name="turbo-cache-control" content="no-cache" /> }
                        }}
                        <title>{raw_text_ok(title)}</title>
                        <link rel="stylesheet" href="/static/app.css" />
                        <script type="module" src="/static/turbo.js"></script>
                        {for url in PRELOADS.iter() {
                            html! { <link rel="modulepreload" href={url.as_str()} /> }
                        }}
                        <script type="module" src="/static/bench.js"></script>
                    </head>
                    <body class={if crate::opts::OPTS.lean_rows { "lean" } else { "" }}>
                        <turbo-stream-source id="live" src="/stream" data-turbo-permanent></turbo-stream-source>
                        {content}
                    </body>
                </html>
            }
            .render(cx)
            .resolve()
            .await
        })
    }
}

pub struct DetailPage {
    pub d: IssueDetail,
}

impl<L: DataLoader> WebRender<L> for DetailPage {
    fn render(self, cx: &mut WebContext<L>) -> RenderOutcome<impl Future<Output = Result<(), WriteError>>> {
        RenderOutcome::pending(async move {
            let d = self.d;
            let id = d.row.id.to_string();
            let heading = format!("{}#{} · {} · updated {}", d.row.repo, d.row.number, d.row.state, d.row.updated_at);
            let options: Vec<LabelOption> = d
                .repo_labels
                .iter()
                .map(|l| LabelOption {
                    name: l.name.clone(),
                    key: format!("{}\t{}", d.row.id, l.name),
                    had: d.row.labels.iter().any(|h| h.name == l.name),
                })
                .collect();
            let title = d.row.title;
            html! {
                <main class="app detail" data-bench="detail" data-id={id}>
                    {to_async(DetailHead { title, heading })}
                    {AddLabels { options }}
                    {to_async(DetailBody { body: d.body, comments: d.comments })}
                </main>
            }
            .render(cx)
            .resolve()
            .await
        })
    }
}
