# TikZ rendering fixtures

These fixtures run through the bundled Vega/Vega-Lite libraries and Vega's
Canvas renderer. They contain all data inline and require no network access.

From `vl-convert-rs`, run the JavaScript integration tests with:

```sh
node --loader ./tests/vendor-loader.mjs --test ./tests/tikz_render.test.mjs
```

Generate SVG references, TikZ pictures, TeX wrappers, and a dimension manifest:

```sh
node --loader ./tests/vendor-loader.mjs ./tests/tikz/generate.mjs tests/output/tikz
```

Add `--compile` to compile every wrapper with `pdflatex`. This optional check
requires the `tikz` and `standalone` packages. The wrappers load LaTeX's
`fix-cm` package to permit the exact requested sizes in Computer Modern. The check runs with
shell escape disabled and reports failure if any picture does not compile.
The exporter itself has no TeX dependency.

| Fixture | Main coverage |
| --- | --- |
| `bars` | Axes, labels, rounded bars, escaped title |
| `curves` | Monotone line/area, point symbols, aggregate reference rule |
| `facet` | Nested group layout, shared scales/color, inherited configuration |
| `repeat` | Repeated panels, inherited point and axis styles |
| `concat` | Shared position scales and colors across filtered views |
| `primitives` | Group clipping, foreground stroke, dash, arc, rotated symbol, SVG path, trail |
| `text` | Escaping, multiline text, rotation, font weight/style, truncation |
| `math` | Explicit raw TeX/math labels |
| `gradient` | Native linear shading with three color stops |

The SVG files are geometry references. TeX uses the enclosing document's font
family; its glyph widths can differ from Vega's measured widths. The wrappers
intentionally use a normal LaTeX font so this limitation remains visible.
Neither raw math nor a change of document font causes Vega to recompute layout.

These Node tests exercise the bundled drawing code with Vega's headless text
measurement fallback. Typography assessment should also compare SVG/PDF and
TikZ generated through the public Rust or Python API, which uses vl-convert's
native font measurement. A successful TeX compilation alone does not establish
visual fidelity or full gallery coverage.

One CSS pixel is exported as `0.75bp`. The manifest records the expected PDF
dimensions, which can be checked with `pdfinfo` alongside a visual review of
the PDF and SVG. The fixtures are test inputs, not a claim that every Vega
paint effect is supported.
