//! Feasibility probe for "Frontend benchmark: Proa". Throwaway.
use std::{collections::HashMap, future::Future, sync::Arc};

use axum::{response::IntoResponse, routing::{get, post}, Json, Router};
use proa_core::{DataLoader, RenderOutcome, WebContext, WebRender, WriteError};
use axum::{extract::Path, http::{header, StatusCode}, response::Response};
use proa_framework_axum::{router_from_spec, IslandManifest, Route, RouteContextLayer, RouteResponse};
use proa_macros::html;
use rsjs::{rsjs, signal, QueryKey};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, rsjs::ClientProps)]
pub struct Row {
    pub id: i64,
    pub title: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Filter {
    pub search: String,
}

fn rows(search: &str) -> Vec<Row> {
    (1..=2000)
        .map(|id| Row { id, title: format!("Issue {id} {}", if id % 3 == 0 { "dark mode" } else { "data" }) })
        .filter(|r| r.title.contains(search))
        .take(20)
        .collect()
}

pub struct Doc;

impl<L: DataLoader> WebRender<L> for Doc {
    fn render(self, cx: &mut WebContext<L>) -> RenderOutcome<impl Future<Output = Result<(), WriteError>>> {
        RenderOutcome::pending(async move {
            html! {
                <!DOCTYPE html>
                <html lang="en">
                    <head><meta charset="utf-8" /><title>"probe"</title></head>
                    <body>
                        {ListProbe { initial: rows("") }}
                        <script src="/app.js"></script>
                    </body>
                </html>
            }
            .render(cx)
            .resolve()
            .await
        })
    }
}

pub struct ListProbe {
    pub initial: Vec<Row>,
}

#[rsjs(component, client)]
impl<L: DataLoader> WebRender<L> for ListProbe {
    fn render(self, cx: &mut WebContext<L>) -> RenderOutcome<impl Future<Output = Result<(), WriteError>>> {
        RenderOutcome::pending(async move {
            let rows = signal(self.initial);
            let selected = signal(String::new());
            let pushed = signal(String::new());
            let search = rsjs::mutation::<String, Vec<Row>>(
                QueryKey::new(("issues", "search")),
                rsjs::FetchRequest {
                    url: "/api/issues",
                    method: Some(rsjs::HttpMethod::Post),
                    response: Some(rsjs::ResponseKind::Json),
                    ..Default::default()
                },
                &[],
            );
            let on_search = rsjs::event_handler(|event: rsjs::InputEvent<rsjs::elem::Input>| {
                search.run(event.current_value());
            });
            let open = rsjs::event_handler(|event: rsjs::MouseEvent<rsjs::elem::Any>| {
                selected.set(event.closest_attr("data-id"));
            });
            let on_push = rsjs::event_handler(|event: rsjs::InputEvent<rsjs::elem::Input>| {
                pushed.set(event.current_value());
            });

            html! {
                <div>
                    <input type="hidden" data-probe="bridge" on_input={on_push()} />
                    <input data-bench="search" on_input={on_search()} />
                    <ul data-bench="list" on_click={open()}>
                        {for row in rows.get() {
                            html! { <li key={row.id} data-id={row.id}>{row.title}</li> }
                        }}
                    </ul>
                    <p data-probe="status">{search.status()}</p>
                    <p data-probe="selected">{selected.get()}</p>
                    <p data-probe="pushed">{pushed.get()}</p>
                </div>
            }
            .render(cx)
            .resolve()
            .await
        })
    }
}

async fn index() -> impl IntoResponse {
    RouteResponse::ssr_async(Doc)
}

async fn api_issues(Json(f): Json<String>) -> Json<Vec<Row>> {
    Json(rows(&f))
}

async fn app_js() -> impl IntoResponse {
    ([("content-type", "application/javascript")], r#"setTimeout(() => { const i = document.querySelector('[data-probe=bridge]'); i.value = 'pushed from app js'; i.dispatchEvent(new Event('input', { bubbles: true })); }, 1500);"#)
}

#[tokio::main]
async fn main() {
    let (router, metadata) = router_from_spec(vec![Route::endpoint("/", get(index))]);
    let manifest = Arc::new(IslandManifest { islands: HashMap::new(), assets: Default::default(), import_map: HashMap::new(), ssr_bundle: None });
    let app: Router = router
        .route("/api/issues", post(api_issues))
        .route("/app.js", get(app_js))
        .route("/rsjs-runtime.js", get(|| async { js(rsjs::runtime_assets::CORE_JS) }))
        .route("/rsjs-runtime-query.js", get(|| async { js(rsjs::runtime_assets::QUERY_JS) }))
        .route("/rsjs/island/:file", get(island))
        .layer(RouteContextLayer::new(manifest, metadata));
    let port = std::env::var("PORT").unwrap_or_else(|_| "3100".into());
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn js(src: &'static str) -> Response {
    ([(header::CONTENT_TYPE, "application/javascript; charset=utf-8")], src).into_response()
}

async fn island(Path(file): Path<String>) -> Response {
    let asset_id = file.strip_suffix(".js").unwrap_or(file.as_str());
    let fragment_id = asset_id.strip_prefix("component_").unwrap_or(asset_id);
    let manifest = rsjs::manifest();
    let source = manifest.islands.iter().find(|e| e.asset_id == asset_id).map(|e| e.js_source).or_else(|| {
        manifest.component_fragments.iter().find(|e| e.asset_id == asset_id || e.asset_id == fragment_id).map(|e| e.js_source)
    });
    match source {
        Some(source) => js(source),
        None => (StatusCode::NOT_FOUND, "unknown rsjs asset").into_response(),
    }
}
