---
title: TikZ Output (Experimental)
path: guides/tikz-output
section: Output and Appearance
order: 236
interfaces: [python, cli, rust, server]
---

<!-- topic-body -->

# TikZ Output (Experimental)

TikZ export produces a `tikzpicture` that can be included in a LaTeX document.
Paths remain vector graphics and labels are typeset by TeX. Conversion returns
source text and does not require or execute a TeX installation.

Vega-Lite compiles to Vega, which evaluates the data, scales, axes, legends, and
layout. The exporter then draws the live scenegraph through Vega's existing
Canvas renderer into a context that writes PGF commands inside a TikZ picture.
This reuses Vega's geometry, interpolation, clipping, and drawing order. It does
not recreate scales or statistical transforms in PGFPlots, and the output does
not contain editable PGFPlots axes or data series.

## Export a Picture

These examples use a specification saved as `chart.vl.json`:

```json
{
  "data": {"values": [{"category": "A", "value": 3}, {"category": "B", "value": 7}]},
  "mark": "bar",
  "encoding": {
    "x": {"field": "category", "type": "nominal"},
    "y": {"field": "value", "type": "quantitative"}
  }
}
```

::::{interface} python
```python
from pathlib import Path

import vl_convert as vlc

spec = Path("chart.vl.json").read_text(encoding="utf-8")
tikz = vlc.vegalite_to_tikz(spec)
Path("chart.tex").write_text(tikz, encoding="utf-8")
```

Use `vlc.vega_to_tikz(spec)` for Vega input. Both functions also accept
dictionaries. The matching `vl_convert.asyncio` functions return the same
string when awaited.
::::

::::{interface} cli
```console
$ vl-convert vl2tikz --input chart.vl.json --output chart.tex
```

Use `vg2tikz` for Vega input. Omitting `--output` writes the source to stdout.
The commands accept the usual configuration, locale, theme, and size options
for their input format.
::::

::::{interface} rust
```rust
use vl_convert_rs::{TikzOpts, VlConverter, VlOpts};

let spec = std::fs::read_to_string("chart.vl.json")?;
let converter = VlConverter::new();
let output = converter
    .vegalite_to_tikz(spec, VlOpts::default(), TikzOpts::default())
    .await?;
std::fs::write("chart.tex", output.tikz)?;
```

Use `vega_to_tikz(spec, VgOpts, TikzOpts)` for Vega input. `TikzOutput` also
carries converter logs and Google Fonts usage, as the other drawing outputs do.
::::

::::{interface} server
Send a JSON body containing `spec` to `POST /vegalite/tikz` or `POST /vega/tikz`.
For example, save the following as `request.json`:

```json
{
  "spec": {
    "data": {"values": [{"category": "A", "value": 3}, {"category": "B", "value": 7}]},
    "mark": "bar",
    "encoding": {
      "x": {"field": "category", "type": "nominal"},
      "y": {"field": "value", "type": "quantitative"}
    }
  },
  "text_mode": "plain"
}
```

```console
$ curl http://127.0.0.1:3000/vegalite/tikz \
>   -H 'Content-Type: application/json' \
>   --data-binary @request.json \
>   --output chart.tex
```

The response body is the picture source with content type `text/x-tex;
charset=utf-8`. Invalid text modes return 400; unsupported drawing features
return a conversion error with status 422.
::::

## Include the Picture in LaTeX

The output is a picture fragment, not a complete LaTeX document. Load `tikz`
and include the fragment with `\input`:

```latex
\documentclass{article}
\usepackage{tikz}
\begin{document}
\begin{figure}
  \centering
  \input{chart.tex}
  \caption{A chart rendered from Vega-Lite.}
\end{figure}
\end{document}
```

The generated picture requires the `tikz` package and no PGFPlots package.
Its physical dimensions use 1 Vega pixel = 0.75 TeX big points (`bp`), matching
96 CSS pixels per inch. Change the chart's width and height before export to
control its layout and size.

## Labels and Mathematical Notation

The default `plain` text mode escapes TeX special characters such as `_`, `%`,
`&`, and `$`. Labels remain ordinary text. For mathematical notation or TeX
macros, explicitly select `raw` mode and provide trusted TeX labels, for example
the Python string `r"$\beta_1$"` or JSON string `"$\\beta_1$"`.

::::{interface} python
```python
tikz = vlc.vegalite_to_tikz(spec, text_mode="raw")
```
::::

::::{interface} cli
```console
$ vl-convert vl2tikz --input chart.vl.json --output chart.tex --text-mode raw
```
::::

::::{interface} rust
Set `TikzOpts { text_mode: TikzTextMode::Raw }` when calling the converter.
Both types are exported from `vl_convert_rs`.
::::

::::{interface} server
Set `"text_mode": "raw"` beside `spec` in the request body.
::::

Raw mode preserves label content as TeX source. It is a document-authoring
option; use it only for text you trust to compile. Any macros or packages used
by those labels must be defined in the containing document. This mode applies
to every label, including generated ticks and legends; literal TeX special
characters in those labels must also be escaped.

Labels inherit the containing document's text font family, and mathematical
expressions use its math-font configuration. The exporter applies Vega's font
sizes and supported bold, italic, and small-caps styling. Registering or
downloading a font for Vega controls its text measurement; it does not embed
that font in the TeX source or select it in LaTeX.

Vega lays out the chart before TeX sees the labels. A different document font,
Unicode font, or mathematical expression can have different metrics, so labels
can overlap or extend beyond the chart boundary. Allow adequate padding and
inspect the compiled figure. Raw TeX is measured as source text by Vega; disable
label truncation or ellipsis that could cut a command in half (for example,
set the relevant `labelLimit` or `titleLimit` to zero). Use a TeX engine
and document font that cover the characters in your labels.

## Supported Drawing Features

The experimental backend supports vector paths, rectangles, rules, symbols,
arcs, lines, areas, trails, and projected shapes through Vega's renderer. This
also supports layered, faceted, repeated, and concatenated charts when their
rendered marks use supported drawing features. Group translations and clipping,
stroke styles, solid colors, opacity, text placement, and supported linear
gradient fills are retained.

The following features currently return errors: images, pattern fills, radial
gradients, gradient strokes or text, blend modes other than `source-over`,
stroked text, and combined italic/small-caps styling. Vega rasterizes some
diagonal linear gradients in nonsquare bounds into patterns; those are
unsupported too. Gradient stops with differing opacity or repeated offsets,
and nonuniform Canvas transforms for strokes or gradients, are unsupported.
There is no automatic raster fallback or implicit asset file.

These limits describe drawing operations, rather than a list of supported
Vega-Lite encodings. They keep the exporter at the same scenegraph rendering
boundary as the existing exporters. SVG and PDF remain available for drawings
that need effects outside this experimental backend's coverage.
