use serde_json::json;
use std::str::FromStr;
use vl_convert_rs::{
    FormatLocale, SvgOpts, TikzOpts, TikzTextMode, VgOpts, VlConverter, VlOpts, VlcConfig,
};

fn converter() -> VlConverter {
    VlConverter::with_config(VlcConfig::default()).unwrap()
}

fn text_spec(label: &str) -> serde_json::Value {
    json!({
        "width": 160, "height": 40,
        "data": {"values": [{"label": label}]},
        "mark": "text",
        "encoding": {"text": {"field": "label"}}
    })
}

#[tokio::test]
async fn tikz_uses_the_same_compiled_vega_for_both_inputs() {
    let converter = converter();
    let spec = text_spec("cost_50% & tax");
    let compiled = converter
        .vegalite_to_vega(spec.clone(), VlOpts::default())
        .await
        .unwrap();
    let svg_before = converter
        .vega_to_svg(compiled.spec.clone(), VgOpts::default(), SvgOpts::default())
        .await
        .unwrap();
    let vl = converter
        .vegalite_to_tikz(spec, VlOpts::default(), TikzOpts::default())
        .await
        .unwrap();
    let vg = converter
        .vega_to_tikz(
            compiled.spec.clone(),
            VgOpts::default(),
            TikzOpts::default(),
        )
        .await
        .unwrap();
    assert_eq!(vl.tikz, vg.tikz);
    assert!(vl.tikz.contains(r"cost\_50\% \& tax"));
    assert!(vl.tikz.contains(r"\begin{tikzpicture}"));
    assert!(vl.tikz.contains(r"\pgftext"));
    assert!(!vl.tikz.contains(r"\begin{axis}"));

    // The lazily loaded adapter must leave subsequent SVG requests unchanged.
    let svg_after = converter
        .vega_to_svg(compiled.spec, VgOpts::default(), SvgOpts::default())
        .await
        .unwrap();
    assert_eq!(svg_before.svg, svg_after.svg);
}

#[tokio::test]
async fn tikz_per_request_plugins_remain_isolated() {
    let converter = VlConverter::with_config(VlcConfig {
        allow_per_request_plugins: true,
        ..Default::default()
    })
    .unwrap();
    let plugin = "export default function(vega) { \
        vega.expressionFunction('tikzLabel', () => 'plugin marker'); }";
    let mut spec = text_spec("unused");
    spec["transform"] = json!([{"calculate": "tikzLabel()", "as": "label"}]);
    let compiled = converter
        .vegalite_to_vega(spec.clone(), VlOpts::default())
        .await
        .unwrap();
    let vl = converter
        .vegalite_to_tikz(
            spec,
            VlOpts {
                vega_plugin: Some(plugin.into()),
                ..Default::default()
            },
            TikzOpts::default(),
        )
        .await
        .unwrap();
    let vg = converter
        .vega_to_tikz(
            compiled.spec.clone(),
            VgOpts {
                vega_plugin: Some(plugin.into()),
                ..Default::default()
            },
            TikzOpts::default(),
        )
        .await
        .unwrap();
    assert!(vl.tikz.contains("plugin marker"));
    assert_eq!(vl.tikz, vg.tikz);
    let error = converter
        .vega_to_tikz(compiled.spec, VgOpts::default(), TikzOpts::default())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("tikzLabel"), "{error}");
}

#[tokio::test]
async fn tikz_preserves_layout_options_and_explicit_raw_labels() {
    let converter = converter();
    let spec = text_spec(r"$\alpha_1$");
    let plain = converter
        .vegalite_to_tikz(spec.clone(), VlOpts::default(), TikzOpts::default())
        .await
        .unwrap();
    let raw = converter
        .vegalite_to_tikz(
            spec,
            VlOpts {
                width: Some(240.0),
                background: Some("#123456".into()),
                config: Some(json!({"text": {"fontWeight": "bold", "fontSize": 20}})),
                ..Default::default()
            },
            TikzOpts {
                text_mode: TikzTextMode::Raw,
            },
        )
        .await
        .unwrap();
    assert!(!plain.tikz.contains(r"$\alpha_1$"));
    assert!(raw.tikz.contains(r"$\alpha_1$"));
    assert!(raw.tikz.contains(r"\bfseries"));
    assert!(raw.tikz.contains(r"\fontsize{15bp}"));
    assert!(raw.tikz.contains("0.070588,0.203922,0.337255"));
    assert_ne!(raw.tikz, plain.tikz);
}

#[tokio::test]
async fn tikz_errors_reset_the_worker_and_locale() {
    let converter = converter();
    let spec = json!({
        "width": 160, "height": 40,
        "marks": [{"type": "text", "encode": {"enter": {
            "x": {"value": 30}, "y": {"value": 20},
            "text": {"signal": "format(1234.5, '$,.1f')"}
        }}}]
    });
    let default = converter
        .vega_to_tikz(spec.clone(), VgOpts::default(), TikzOpts::default())
        .await
        .unwrap();
    let locale = FormatLocale::Object(json!({
        "decimal": "d", "thousands": "t", "grouping": [3], "currency": ["X", ""]
    }));
    let localized = converter
        .vega_to_tikz(
            spec.clone(),
            VgOpts {
                format_locale: Some(locale.clone()),
                ..Default::default()
            },
            TikzOpts::default(),
        )
        .await
        .unwrap();
    assert!(localized.tikz.contains("X1t234d5"));
    let unsupported = json!({
        "width": 40, "height": 40,
        "marks": [{"type": "image", "encode": {"enter": {
            "url": {"value": "data:image/png;base64,"}
        }}}]
    });
    let error = converter
        .vega_to_tikz(
            unsupported,
            VgOpts {
                format_locale: Some(locale),
                ..Default::default()
            },
            TikzOpts::default(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("image"), "{error}");
    let after = converter
        .vega_to_tikz(spec, VgOpts::default(), TikzOpts::default())
        .await
        .unwrap();
    assert_eq!(default.tikz, after.tikz);
}

#[tokio::test]
async fn tikz_reuses_data_access_controls() {
    let converter = VlConverter::with_config(VlcConfig {
        allowed_base_urls: vec![],
        ..Default::default()
    })
    .unwrap();
    let spec = json!({
        "data": [{"name": "remote", "url": "https://example.com/data.json"}],
        "marks": []
    });
    assert!(converter
        .vega_to_tikz(spec, VgOpts::default(), TikzOpts::default())
        .await
        .is_err());
}

#[test]
fn tikz_text_mode_is_explicit_and_serializes_for_javascript() {
    assert_eq!(
        TikzTextMode::from_str("plain").unwrap(),
        TikzTextMode::Plain
    );
    assert_eq!(TikzTextMode::from_str("raw").unwrap(), TikzTextMode::Raw);
    assert!(TikzTextMode::from_str("unknown").is_err());
    assert_eq!(
        serde_json::to_value(TikzOpts::default()).unwrap(),
        json!({"textMode": "plain"})
    );
}
