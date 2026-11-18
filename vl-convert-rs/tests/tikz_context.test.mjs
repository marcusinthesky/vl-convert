// Run from vl-convert-rs with:
// node --loader ./tests/vendor-loader.mjs --test ./tests/tikz_context.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {createTikzContext, validateTikzScenegraph} from "../src/js/tikz.js";

const occurrences = (text, needle) => text.split(needle).length - 1;

test("path coordinates retain their construction transform after Vega undoes it", () => {
  const ctx = createTikzContext();
  ctx.translate(10, 20);
  ctx.rotate(Math.PI / 2);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(4, 0);
  ctx.rotate(-Math.PI / 2);
  ctx.translate(-10, -20);
  ctx.stroke();
  const tex = ctx.toTikz(40, 40);
  assert.ok(tex.includes("\\pgfpathmoveto{\\pgfpoint{7.5bp}{-15bp}}"));
  assert.ok(tex.includes("\\pgfpathlineto{\\pgfpoint{7.5bp}{-18bp}}"));
  assert.ok(tex.includes("\\pgfsetlinewidth{0.75bp}"));
});

test("Canvas save/restore restores styles, but does not restore or discard the path", () => {
  const ctx = createTikzContext();
  ctx.fillStyle = "red";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.save();
  ctx.fillStyle = "blue";
  ctx.translate(10, 0);
  ctx.lineTo(0, 10);
  ctx.restore();
  ctx.lineTo(0, 10);
  ctx.closePath();
  ctx.fill();
  const tex = ctx.toTikz(20, 20);
  assert.ok(tex.includes("\\definecolor{vlctikzcolor}{rgb}{1,0,0}"));
  assert.ok(tex.includes("\\pgfpathlineto{\\pgfpoint{7.5bp}{-7.5bp}}"));
  assert.ok(tex.includes("\\pgfpathlineto{\\pgfpoint{0bp}{-7.5bp}}"));
});

test("filling and stroking replay the same path with separate alpha", () => {
  const ctx = createTikzContext();
  ctx.rect(2, 4, 10, 8);
  ctx.fillStyle = "rgba(255, 0, 0, 0.5)";
  ctx.globalAlpha = 0.4;
  ctx.fill();
  ctx.strokeStyle = "#0000ff80";
  ctx.globalAlpha = 1;
  ctx.stroke();
  const tex = ctx.toTikz(20, 20);
  assert.ok(tex.includes("\\pgfsetfillopacity{0.2}"));
  assert.ok(tex.includes("\\pgfsetstrokeopacity{0.501961}"));
  assert.equal(occurrences(tex, "\\pgfpathmoveto{\\pgfpoint{1.5bp}{-3bp}}"), 2);
});

test("transparent colors and zero opacity produce no painted geometry", () => {
  const ctx = createTikzContext();
  ctx.rect(0, 0, 10, 10);
  ctx.fillStyle = "transparent";
  ctx.fill();
  ctx.strokeStyle = "transparent";
  ctx.stroke();
  ctx.globalAlpha = 0;
  ctx.fillStyle = "red";
  ctx.fill();
  ctx.fillText("hidden", 0, 0);
  const tex = ctx.toTikz(10, 10);
  assert.equal(occurrences(tex, "\\pgfusepath{fill}"), 0);
  assert.equal(occurrences(tex, "\\pgfusepath{stroke}"), 0);
  assert.ok(!tex.includes("NaN"));
  assert.ok(!tex.includes("hidden"));
});

test("fillRect leaves the current path available for later stroke", () => {
  const ctx = createTikzContext();
  ctx.moveTo(1, 2);
  ctx.lineTo(3, 4);
  ctx.fillRect(10, 20, 30, 40);
  ctx.stroke();
  const tex = ctx.toTikz(60, 70);
  assert.ok(tex.includes("\\pgfpathmoveto{\\pgfpoint{0.75bp}{-1.5bp}}"));
  assert.ok(tex.includes("\\pgfpathlineto{\\pgfpoint{2.25bp}{-3bp}}"));
});

test("quadratic curves convert to cubic curves in the transformed coordinate space", () => {
  const ctx = createTikzContext();
  ctx.translate(10, 20);
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(10, 0, 10, 10);
  ctx.stroke();
  const tex = ctx.toTikz(40, 40);
  assert.ok(tex.includes("\\pgfpathcurveto{\\pgfpoint{12.5bp}{-15bp}}{\\pgfpoint{15bp}{-17.5bp}}{\\pgfpoint{15bp}{-22.5bp}}"));
});

test("full circles are four cubic segments, and arc direction survives y inversion", () => {
  const circle = createTikzContext();
  circle.arc(20, 20, 10, 0, 2 * Math.PI);
  circle.closePath();
  circle.fill();
  const tex = circle.toTikz(40, 40);
  assert.equal(occurrences(tex, "\\pgfpathcurveto"), 4);
  assert.ok(tex.includes("\\pgfpathmoveto{\\pgfpoint{22.5bp}{-15bp}}"));
  const clockwise = createTikzContext();
  clockwise.arc(0, 0, 10, 0, Math.PI / 2);
  clockwise.stroke();
  assert.ok(clockwise.toTikz(20, 20).includes("{\\pgfpoint{0bp}{-7.5bp}}"));
  const counterclockwise = createTikzContext();
  counterclockwise.arc(0, 0, 10, 0, -Math.PI / 2, true);
  counterclockwise.stroke();
  assert.ok(counterclockwise.toTikz(20, 20).includes("{\\pgfpoint{0bp}{7.5bp}}"));
});

test("arcs connect to an existing subpath before drawing", () => {
  const ctx = createTikzContext();
  ctx.moveTo(0, 0);
  ctx.arc(10, 10, 5, 0, Math.PI);
  ctx.stroke();
  assert.ok(ctx.toTikz(30, 30).includes("\\pgfpathlineto{\\pgfpoint{11.25bp}{-7.5bp}}"));
});

test("odd dash arrays repeat, zero arrays become solid, and all lengths use bp", () => {
  const ctx = createTikzContext();
  ctx.moveTo(0, 0); ctx.lineTo(20, 20);
  ctx.setLineDash([2, 4, 6]);
  ctx.lineDashOffset = -2;
  ctx.lineCap = "square";
  ctx.lineJoin = "bevel";
  ctx.miterLimit = 4;
  ctx.stroke();
  ctx.setLineDash([0, 0]);
  ctx.stroke();
  const tex = ctx.toTikz(30, 30);
  assert.ok(tex.includes("\\pgfsetdash{{1.5bp}{3bp}{4.5bp}{1.5bp}{3bp}{4.5bp}}{-1.5bp}"));
  assert.ok(tex.includes("\\pgfsetdash{}{-1.5bp}"));
  assert.ok(tex.includes("\\pgfsetrectcap"));
  assert.ok(tex.includes("\\pgfsetbeveljoin"));
  assert.deepEqual(ctx.getLineDash(), []);
});

test("nested clip scopes are balanced and final bounds match declared canvas dimensions", () => {
  const ctx = createTikzContext();
  ctx.save();
  ctx.rect(0, 0, 10, 10);
  ctx.clip();
  ctx.save();
  ctx.translate(4, 5);
  ctx.beginPath();
  ctx.rect(0, 0, 3, 2);
  ctx.clip("evenodd");
  ctx.fillRect(-100, -100, 200, 200);
  ctx.restore(); ctx.restore();
  const tex = ctx.toTikz(40, 20);
  assert.equal(occurrences(tex, "\\begin{pgfscope}"), occurrences(tex, "\\end{pgfscope}"));
  assert.equal(occurrences(tex, "\\pgfusepath{clip}"), 3); // viewport plus both explicit clips
  assert.ok(tex.includes("\\pgfseteorule"));
  assert.ok(tex.includes("\\pgfresetboundingbox%\n\\pgfpathrectangle{\\pgfpoint{0bp}{-15bp}}{\\pgfpoint{30bp}{15bp}}%\n\\pgfusepath{use as bounding box}"));
});

test("plain text escapes TeX syntax while raw mode is explicit", () => {
  const value = String.raw`cost_50% & tax $x$ # {a} \input{secret} ^~`;
  const plain = createTikzContext();
  plain.fillText(value, 0, 0);
  const tex = plain.toTikz(100, 20);
  assert.ok(tex.includes(String.raw`cost\_50\% \& tax \$x\$ \# \{a\} \textbackslash{}input\{secret\} \textasciicircum{}\textasciitilde{}`));
  assert.ok(!tex.includes(String.raw`\input{secret}`));
  const raw = createTikzContext({textMode: "raw"});
  raw.fillText(String.raw`$\alpha_1$`, 0, 0);
  assert.ok(raw.toTikz(100, 20).includes(String.raw`$\alpha_1$`));
  assert.throws(() => createTikzContext({textMode: "latex"}), /textMode.*plain.*raw/);
});

test("common Unicode minus and ellipsis remain usable with pdfLaTeX", () => {
  const ctx = createTikzContext();
  ctx.fillText("−12…", 0, 0);
  assert.ok(ctx.toTikz(40, 20).includes(String.raw`\ensuremath{-}12\textellipsis{}`));
});

test("text honors numeric weight, size and rotation without applying a second baseline offset", () => {
  const ctx = createTikzContext();
  ctx.font = "italic 700 12px 'A CSS family'";
  ctx.textAlign = "right";
  ctx.translate(10, 20);
  ctx.rotate(Math.PI / 2);
  ctx.fillText("label", 0, 0);
  const tex = ctx.toTikz(60, 60);
  assert.ok(tex.includes(String.raw`\bfseries\itshape\fontsize{9bp}{10.8bp}\selectfont`));
  assert.ok(tex.includes(String.raw`\pgftransformcm{0}{-1}{1}{0}{\pgfpoint{7.5bp}{-15bp}}`));
  assert.ok(tex.includes(String.raw`\pgftext[right,base]`));
  assert.ok(!tex.includes("A CSS family"));
});

test("CSS font family text is never inserted as TeX", () => {
  const ctx = createTikzContext();
  ctx.font = String.raw`11px \input{unsafe}`;
  ctx.fillText("safe", 0, 0);
  assert.ok(!ctx.toTikz(20, 20).includes("unsafe"));
});

test("linear gradients cover their clipped path and extend endpoint colors", () => {
  const ctx = createTikzContext();
  const gradient = ctx.createLinearGradient(20, 0, 80, 0);
  gradient.addColorStop(0, "red");
  gradient.addColorStop(1, "blue");
  ctx.fillStyle = gradient;
  ctx.rect(0, 0, 100, 20);
  ctx.fill();
  const tex = ctx.toTikz(100, 20);
  assert.ok(tex.includes(String.raw`\pgfdeclarehorizontalshading{vlctikz-\pgfpictureid-1}{15bp}`));
  assert.ok(tex.includes("rgb(0bp)=(1,0,0); rgb(15bp)=(1,0,0); rgb(60bp)=(0,0,1); rgb(75bp)=(0,0,1)"));
  assert.ok(tex.includes(String.raw`\pgftransformcm{1}{0}{0}{-1}{\pgfpoint{37.5bp}{-7.5bp}}`));
  assert.ok(tex.includes("\\pgflowlevelsynccm"));
});

test("linear gradients preserve transform-at-creation and constant stop alpha", () => {
  const ctx = createTikzContext();
  ctx.translate(10, 0);
  const gradient = ctx.createLinearGradient(0, 0, 20, 0);
  gradient.addColorStop(0, "rgba(255,0,0,.5)");
  gradient.addColorStop(1, "rgba(0,0,255,.5)");
  ctx.translate(-10, 0);
  ctx.fillStyle = gradient;
  ctx.globalAlpha = 0.5;
  ctx.rect(10, 0, 20, 10);
  ctx.fill();
  const tex = ctx.toTikz(40, 10);
  assert.ok(tex.includes("\\pgfsetfillopacity{0.25}"));
  assert.ok(tex.includes("\\pgfpoint{15bp}{-3.75bp}"));
});

test("unsupported gradient effects fail explicitly", () => {
  const ctx = createTikzContext();
  ctx.rect(0, 0, 10, 10);
  let gradient = ctx.createLinearGradient(0, 0, 10, 0);
  gradient.addColorStop(0, "transparent");
  gradient.addColorStop(1, "blue");
  ctx.fillStyle = gradient;
  assert.throws(() => ctx.fill(), /varying stop opacity/);
  gradient = ctx.createLinearGradient(0, 0, 10, 0);
  gradient.addColorStop(.5, "red");
  gradient.addColorStop(.5, "blue");
  ctx.fillStyle = gradient;
  assert.throws(() => ctx.fill(), /repeated stop offsets/);
  ctx.strokeStyle = gradient;
  assert.throws(() => ctx.stroke(), /gradient strokes/);
  assert.throws(() => ctx.fillText("label", 0, 0), /gradient text/);
  assert.throws(() => ctx.createRadialGradient(), /radial gradients/);
  assert.throws(() => ctx.createPattern(), /raster patterns/);
});

test("preflight rejects unsupported content before rendering can skip it", () => {
  const root = item => ({marktype: "group", items: [{items: [item]}]});
  assert.throws(() => validateTikzScenegraph(root({marktype: "image", items: []})), /image marks/);
  assert.throws(() => validateTikzScenegraph(root({marktype: "text", items: [{text: "x", stroke: "black"}]})), /stroked text/);
  assert.throws(() => validateTikzScenegraph(root({marktype: "rect", items: [{blend: "multiply"}]})), /blend mode/);
  assert.throws(() => validateTikzScenegraph(root({marktype: "rect", items: [{fill: {gradient: "radial"}}]})), /radial gradients/);
  assert.throws(() => validateTikzScenegraph(root({marktype: "rect", items: [{
    fill: {gradient: "linear", x1: 0, y1: 0, x2: 1, y2: 1},
    bounds: {width: () => 20, height: () => 10},
  }]})), /diagonal gradients.*nonsquare/);
  validateTikzScenegraph(root({marktype: "rect", items: [{fill: "blue"}]}));
});

test("invalid numbers and unsupported drawing operations produce useful errors", () => {
  const ctx = createTikzContext();
  assert.throws(() => ctx.moveTo(NaN, 0), /finite number/);
  assert.throws(() => ctx.translate(0, Infinity), /finite number/);
  assert.throws(() => ctx.arc(0, 0, -1, 0, 1), /radius/);
  assert.throws(() => ctx.setLineDash([1, -2]), /dash lengths/);
  assert.throws(() => ctx.toTikz(-1, 10), /dimensions/);
  assert.throws(() => ctx.toTikz(30000, 10), /maximum dimension/);
  assert.throws(() => ctx.drawImage(), /image marks/);
  assert.throws(() => ctx.strokeText(), /stroked text/);
  ctx.fillStyle = "not a CSS color";
  ctx.rect(0, 0, 10, 10);
  assert.throws(() => ctx.fill(), /unsupported CSS color/);
  ctx.fillStyle = "blue";
  ctx.globalAlpha = 2;
  assert.throws(() => ctx.fill(), /opacity/);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "multiply";
  assert.throws(() => ctx.fill(), /blend mode/);
});

test("state-balance errors are caught and a fresh context remains deterministic", () => {
  const ctx = createTikzContext();
  ctx.save();
  assert.throws(() => ctx.toTikz(10, 10), /unbalanced/);
  ctx.restore();
  const result = ctx.toTikz(10, 10);
  assert.equal(result, ctx.toTikz(10, 10));
  const fresh = createTikzContext();
  fresh.fillRect(0, 0, 1, 1);
  assert.ok(fresh.toTikz(10, 10).includes("\\pgfusepath{fill}"));
});
