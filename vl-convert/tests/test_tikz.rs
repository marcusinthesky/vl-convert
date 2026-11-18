#![allow(deprecated)]

mod common;

use common::vl_convert_cmd;
use std::io::Write;
use std::process::{Output, Stdio};

const VL_TEXT: &str = r#"{
  "width": 120,
  "height": 40,
  "data": {"values": [{"label": "cost_50% & tax"}]},
  "mark": "text",
  "encoding": {"text": {"field": "label"}}
}"#;

fn run_stdin(args: &[&str], spec: &str) -> Result<Output, Box<dyn std::error::Error>> {
    let mut child = vl_convert_cmd()?
        .args(["--vlc-config", "disabled"])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().unwrap().write_all(spec.as_bytes())?;
    Ok(child.wait_with_output()?)
}

#[test]
fn vl2tikz_stdin_stdout_escapes_labels() -> Result<(), Box<dyn std::error::Error>> {
    let output = run_stdin(&["vl2tikz"], VL_TEXT)?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout)?;
    assert!(text.contains(r"\begin{tikzpicture}"));
    assert!(text.contains(r"\end{tikzpicture}"));
    assert!(text.contains(r"cost\_50\% \& tax"));
    Ok(())
}

#[test]
fn vg2tikz_writes_tex_file_with_explicit_raw_text() -> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("chart.tex");
    let spec = r#"{
      "width": 120,
      "height": 40,
      "marks": [{"type": "text", "encode": {"enter": {
        "x": {"value": 40}, "y": {"value": 20},
        "text": {"value": "$\\alpha_1$"}
      }}}]
    }"#;
    let output = run_stdin(
        &[
            "vg2tikz",
            "--text-mode",
            "raw",
            "--output",
            path.to_str().unwrap(),
        ],
        spec,
    )?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    let text = std::fs::read_to_string(path)?;
    assert!(text.contains(r"$\alpha_1$"));
    Ok(())
}

#[test]
fn tikz_commands_reject_unknown_text_mode() -> Result<(), Box<dyn std::error::Error>> {
    for command in ["vl2tikz", "vg2tikz"] {
        let output = vl_convert_cmd()?
            .args([command, "--text-mode", "invalid"])
            .output()?;
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("plain, raw"));
        assert!(output.stdout.is_empty());
    }
    Ok(())
}

#[test]
fn tikz_commands_forward_format_locale() -> Result<(), Box<dyn std::error::Error>> {
    let locale = r#"{"decimal":"d","thousands":"t","grouping":[3],"currency":["X",""]}"#;
    let spec = r#"{
      "width": 120,
      "height": 40,
      "marks": [{"type": "text", "encode": {"enter": {
        "x": {"value": 40}, "y": {"value": 20},
        "text": {"signal": "format(1234.5, '$,.1f')"}
      }}}]
    }"#;
    let output = run_stdin(&["vg2tikz", "--format-locale", locale], spec)?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8(output.stdout)?.contains("X1t234d5"));
    Ok(())
}
