//! The platform's liveness probe: it names the running build and touches no database.

#[tokio::test]
async fn healthz_answers_with_the_build_id() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(beghu::serve(listener, beghu::Config::new("abc123")));

    let res = reqwest::get(format!("http://{addr}/healthz"))
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["x-beghu-build"], "abc123");
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body, serde_json::json!({ "build": "abc123" }));
}
