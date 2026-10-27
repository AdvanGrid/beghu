//! The App's webhook deliveries, as GitHub keeps them (`/rest/apps/webhooks`), with the App's
//! JWT: every attempt the fake made (`webhooks.rs` logs them) for 3 days on the fake's clock.
//!
//! - `GET /app/hook/deliveries?per_page=&cursor=&status=`: newest first, `per_page` at most 100
//!   (default 30), paged by an opaque `cursor` that the `Link` header's `next` carries. `status`
//!   is `success` (a 2xx or 3xx answer) or `failure`. Each item has GitHub's fields: `id`,
//!   `guid`, `delivered_at`, `redelivery`, `duration`, `status`, `status_code`, `event`,
//!   `action`, `installation_id`, `repository_id` and `throttled_at`.
//! - `POST /app/hook/deliveries/{delivery_id}/attempts`: sends that delivery again under its own
//!   GUID, logged with `redelivery: true`; 202. A delivery past the 3 days, or never made, is a
//!   404.

use crate::Fake;
use crate::api::{self, rfc3339};
use crate::webhooks::{Attempt, Delivery};
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};

pub(crate) fn router() -> Router<Fake> {
    Router::new()
        .route("/app/hook/deliveries", get(list))
        .route(
            "/app/hook/deliveries/{delivery_id}/attempts",
            post(redeliver),
        )
}

#[derive(Deserialize)]
struct Params {
    per_page: Option<i64>,
    cursor: Option<String>,
    status: Option<String>,
}

fn cursor(id: i64) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("delivery:{id}"))
}

fn uncursor(c: &str) -> Option<i64> {
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(c)
        .ok()?;
    String::from_utf8(raw)
        .ok()?
        .strip_prefix("delivery:")?
        .parse()
        .ok()
}

/// An attempt as GitHub lists it.
fn item(a: &Attempt) -> Value {
    json!({
        "id": a.id,
        "guid": a.guid,
        "delivered_at": rfc3339(a.delivered_at),
        "redelivery": a.redelivery,
        "duration": (a.duration * 100.0).round() / 100.0,
        "status": a.status,
        "status_code": a.status_code,
        "event": a.event,
        "action": a.payload["action"].as_str(),
        "installation_id": a.payload["installation"]["id"].as_i64(),
        "repository_id": a.payload["repository"]["id"].as_i64(),
        "throttled_at": null,
    })
}

async fn list(State(fake): State<Fake>, headers: HeaderMap, Query(p): Query<Params>) -> Response {
    if let Err(r) = crate::app::check_jwt(&fake, &headers) {
        return r;
    }
    let per_page = p.per_page.unwrap_or(30).clamp(1, 100) as usize;
    let before = match p.cursor.as_deref() {
        None => i64::MAX,
        Some(c) => match uncursor(c) {
            Some(id) => id,
            // Unverified (#118): neither GitHub's docs nor docs/research say what a cursor it
            // didn't hand out gets; a 422 is this fake's guess, and beghu only sends GitHub's own.
            None => return api::error(StatusCode::UNPROCESSABLE_ENTITY, "Invalid cursor"),
        },
    };
    let failed = match p.status.as_deref() {
        None => None,
        Some("success") => Some(false),
        Some("failure") => Some(true),
        Some(_) => return api::error(StatusCode::UNPROCESSABLE_ENTITY, "Validation Failed"),
    };
    let (page, more) = fake.state().webhooks.log(fake.now(), |all| {
        let mut picked = all
            .iter()
            .rev()
            .filter(|a| a.id < before)
            .filter(|a| failed.is_none_or(|f| f != (200..400).contains(&a.status_code)));
        let page: Vec<Attempt> = picked.by_ref().take(per_page).cloned().collect();
        let more = picked.next().is_some();
        (page, more)
    });
    let items: Vec<Value> = page.iter().map(item).collect();
    let mut res = axum::Json(items).into_response();
    if more && let Some(last) = page.last() {
        let host = headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost");
        let mut q = vec![
            ("per_page", per_page.to_string()),
            ("cursor", cursor(last.id)),
        ];
        if let Some(s) = &p.status {
            q.push(("status", s.clone()));
        }
        let link = format!(
            "<http://{host}/app/hook/deliveries?{}>; rel=\"next\"",
            serde_urlencoded::to_string(&q).unwrap_or_default()
        );
        if let Ok(v) = HeaderValue::from_str(&link) {
            res.headers_mut().insert(header::LINK, v);
        }
    }
    res
}

async fn redeliver(State(fake): State<Fake>, headers: HeaderMap, Path(id): Path<i64>) -> Response {
    if let Err(r) = crate::app::check_jwt(&fake, &headers) {
        return r;
    }
    let found = fake.state().webhooks.log(fake.now(), |all| {
        all.iter().find(|a| a.id == id).map(|a| Delivery {
            guid: a.guid.clone(),
            event: a.event,
            payload: a.payload.clone(),
            redelivery: true,
            lost: false,
        })
    });
    match found {
        Some(d) => {
            fake.state().webhooks.redeliver(d);
            (StatusCode::ACCEPTED, axum::Json(json!({}))).into_response()
        }
        None => api::not_found().await,
    }
}
