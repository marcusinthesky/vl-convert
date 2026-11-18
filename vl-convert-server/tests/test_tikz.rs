mod common;

use common::*;
use serde_json::{json, Value};

fn text_spec(vegalite: bool, label: &str) -> Value {
    if vegalite {
        json!({
            "width": 120,
            "height": 40,
            "data": {"values": [{}]},
            "mark": "text",
            "encoding": {"text": {"value": label}}
        })
    } else {
        json!({
            "width": 120,
            "height": 40,
            "marks": [{
                "type": "text",
                "encode": {"enter": {
                    "x": {"value": 20},
                    "y": {"value": 20},
                    "text": {"value": label}
                }}
            }]
        })
    }
}

#[tokio::test]
async fn test_tikz_plain_and_raw_labels() {
    let server = &*DEFAULT_SERVER;
    for (input, vegalite) in [("vega", false), ("vegalite", true)] {
        let spec = text_spec(vegalite, "$x_1$ & 50%");
        let response = server
            .client
            .post(format!("{}/{input}/tikz", server.base_url))
            .json(&json!({"spec": spec}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["content-type"],
            "text/x-tex; charset=utf-8"
        );
        let plain = response.text().await.unwrap();
        assert!(plain.contains(r"\begin{tikzpicture}"));
        assert!(plain.contains(r"\$x\_1\$ \& 50\%"));

        let response = server
            .client
            .post(format!("{}/{input}/tikz", server.base_url))
            .json(&json!({"spec": spec, "text_mode": "raw"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let raw = response.text().await.unwrap();
        assert!(raw.contains("$x_1$ & 50%"));
        assert_ne!(plain, raw);
    }
}

#[tokio::test]
async fn test_tikz_validates_options_and_preserves_overrides() {
    let server = &*DEFAULT_SERVER;
    for (input, vegalite) in [("vega", false), ("vegalite", true)] {
        let spec = text_spec(vegalite, "label");
        let response = server
            .client
            .post(format!("{}/{input}/tikz", server.base_url))
            .json(&json!({"spec": spec, "text_mode": "unknown"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        assert!(response.json::<Value>().await.unwrap()["error"].is_string());

        let mut outputs = Vec::new();
        for width in [120, 240] {
            let response = server
                .client
                .post(format!("{}/{input}/tikz", server.base_url))
                .json(&json!({"spec": spec, "width": width, "background": "#123456"}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            outputs.push(response.text().await.unwrap());
        }
        assert_ne!(outputs[0], outputs[1], "width override must affect {input}");
    }
}

#[tokio::test]
async fn test_tikz_unsupported_drawing_returns_conversion_error() {
    let server = &*DEFAULT_SERVER;
    let spec = json!({
        "width": 40,
        "height": 40,
        "marks": [{
            "type": "rect",
            "encode": {"enter": {
                "x": {"value": 0}, "y": {"value": 0},
                "width": {"value": 30}, "height": {"value": 30},
                "fill": {"value": "red"},
                "blend": {"value": "multiply"}
            }}
        }]
    });
    let response = server
        .client
        .post(format!("{}/vega/tikz", server.base_url))
        .json(&json!({"spec": spec}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 422);
    let error = response.json::<Value>().await.unwrap();
    assert!(error["error"].as_str().unwrap().contains("TikZ"));
}

#[test]
fn test_tikz_openapi_documents_both_routes() {
    let api = serde_json::to_value(vl_convert_server::public_openapi()).unwrap();
    for input in ["vega", "vegalite"] {
        let operation = &api["paths"][format!("/{input}/tikz")]["post"];
        assert!(operation["requestBody"].is_object());
        assert!(operation["responses"]["200"]["content"]["text/x-tex"].is_object());
        assert!(operation["responses"]["400"].is_object());
        assert!(operation["responses"]["422"].is_object());
    }
}
