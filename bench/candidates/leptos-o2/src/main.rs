#[cfg(feature = "ssr")]
#[tokio::main]
async fn main() {
    use axum::{
        Router,
        http::{HeaderMap, StatusCode},
        response::sse::{Event, KeepAlive, Sse},
        routing::{get, post},
    };
    use bench_leptos::{app::*, db};
    use futures_util::StreamExt;
    use leptos::prelude::*;
    use leptos_axum::{LeptosRoutes, generate_route_list};
    use tokio_stream::wrappers::BroadcastStream;

    db::init(&std::env::var("MIRROR_PATH").unwrap_or_else(|_| "/data/mirror.db".into()));

    let conf = get_configuration(None).unwrap();
    let mut leptos_options = conf.leptos_options;
    if let Ok(port) = std::env::var("PORT") {
        leptos_options.site_addr = format!("0.0.0.0:{port}").parse().unwrap();
    }
    let addr = leptos_options.site_addr;
    let routes = generate_route_list(App);

    async fn webhook(headers: HeaderMap, body: String) -> StatusCode {
        let event = headers.get("x-github-event").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&body) else { return StatusCode::BAD_REQUEST };
        match db::run(move |c| db::webhook(c, &event, &payload)).await {
            Ok(ids) if ids.is_empty() => StatusCode::ACCEPTED,
            Ok(ids) => {
                db::broadcast(ids);
                StatusCode::ACCEPTED
            }
            Err(e) => {
                eprintln!("webhook: {e}");
                StatusCode::INTERNAL_SERVER_ERROR
            }
        }
    }

    async fn events() -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>> {
        let stream = BroadcastStream::new(db::subscribe())
            .filter_map(|ids| async move { ids.ok() })
            .map(|ids| Ok(Event::default().data(serde_json::to_string(&ids).unwrap())));
        Sse::new(stream).keep_alive(KeepAlive::default())
    }

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/webhook", post(webhook))
        .route("/events", get(events))
        .leptos_routes(&leptos_options, routes, {
            let leptos_options = leptos_options.clone();
            move || shell(leptos_options.clone())
        })
        .fallback(leptos_axum::file_and_error_handler(shell))
        .with_state(leptos_options);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("listening on http://{addr}");
    // Open SSE streams never end, so a graceful shutdown would hang: exit on SIGTERM instead.
    tokio::spawn(async {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
        term.recv().await;
        std::process::exit(0);
    });
    axum::serve(listener, app.into_make_service()).await.unwrap();
}

#[cfg(not(feature = "ssr"))]
pub fn main() {}
