// A drawing context for Vega's CanvasRenderer, not a chart compiler. Vega owns
// scene traversal, mark geometry, layout, clipping, and text baseline placement.
import {color as parseColor} from "https://cdn.jsdelivr.net/npm/d3-color@3.1.0/+esm";

const PX_TO_BP = 0.75;
const TAU = 2 * Math.PI;
const EPSILON = 1e-10;
const MARKS = new Set([
  "arc", "area", "group", "line", "path", "rect", "rule", "shape", "symbol", "text", "trail",
]);

function fail(message) {
  throw new Error(`TikZ export: ${message}`);
}

function finite(value, name = "coordinate") {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${name} must be a finite number`);
  }
  return value;
}

function number(value) {
  finite(value);
  // TeX dimensions do not accept JavaScript's exponential number notation.
  if (Math.abs(value) > 1e8) fail("numeric value exceeds the supported TeX range");
  return Number(value.toFixed(6)).toString();
}

function length(px) {
  const bp = finite(px) * PX_TO_BP;
  // Keep within TeX's dimension limit, including the bp -> pt conversion.
  if (Math.abs(bp) > 16000) fail("drawing exceeds TeX's maximum dimension");
  return `${number(bp)}bp`;
}

function point(x, y) {
  return `\\pgfpoint{${length(x)}}{${length(-y)}}`;
}

function opacity(value) {
  finite(value, "opacity");
  if (value < 0 || value > 1) fail("opacity must be between zero and one");
  return value;
}

function rgba(value) {
  if (typeof value !== "string") fail("paint must be a CSS color or a supported linear gradient");
  const parsed = parseColor(value);
  if (!parsed) fail(`unsupported CSS color: ${JSON.stringify(value)}`);
  const rgb = parsed.rgb();
  const alpha = Math.max(0, Math.min(1, rgb.opacity));
  // d3-color represents transparent with NaN color components.
  const channel = v => alpha === 0 ? 0 : Math.max(0, Math.min(255, finite(v, "color component"))) / 255;
  return {r: channel(rgb.r), g: channel(rgb.g), b: channel(rgb.b), alpha};
}

function rgbString(color) {
  return [color.r, color.g, color.b].map(number).join(",");
}

function escapeText(text) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    fail("text contains unsupported control characters");
  }
  const replacements = {
    "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}",
    "$": "\\$", "&": "\\&", "%": "\\%", "#": "\\#", "_": "\\_",
    "^": "\\textasciicircum{}", "~": "\\textasciitilde{}",
    // These are common Vega tick/ellipsis characters, including with pdfLaTeX.
    "−": "\\ensuremath{-}", "…": "\\textellipsis{}",
    "\r": " ", "\n": " ", "\t": " ",
  };
  return text.replace(/[\\{}$&%#_^~−…\r\n\t]/g, character => replacements[character]);
}

function fontCommands(font) {
  const match = /^(.*?)\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)px\s+.+$/.exec(String(font).trim());
  if (!match) fail("unsupported canvas font; expected a size in CSS pixels");
  const size = finite(Number(match[2]), "font size");
  if (size <= 0) fail("font size must be positive");
  const tokens = match[1].trim().toLowerCase().split(/\s+/).filter(Boolean);
  let bold = false, shape = "up", smallCaps = false;
  for (const token of tokens) {
    if (token === "normal") continue;
    if (token === "bold" || token === "bolder") bold = true;
    else if (token === "lighter") bold = false;
    else if (token === "italic") shape = "it";
    else if (token === "oblique") shape = "sl";
    else if (token === "small-caps") smallCaps = true;
    else if (/^\d+(?:\.\d+)?$/.test(token) && +token >= 1 && +token <= 1000) bold = +token >= 600;
    else fail(`unsupported font style: ${JSON.stringify(token)}`);
  }
  if (smallCaps && shape !== "up") fail("combined small-caps and italic/oblique text is not supported");
  if (smallCaps) shape = "sc";
  // Deliberately keep the document's family. CSS family names are neither TeX
  // commands nor portable font identifiers, and are never inserted into TeX.
  return `\\${bold ? "bf" : "md"}series\\${shape}shape\\fontsize{${length(size)}}{${length(size * 1.2)}}\\selectfont`;
}

function transformPoint(matrix, x, y) {
  finite(x); finite(y);
  return [
    finite(matrix[0] * x + matrix[2] * y + matrix[4]),
    finite(matrix[1] * x + matrix[3] * y + matrix[5]),
  ];
}

function uniformScale(matrix) {
  const x = Math.hypot(matrix[0], matrix[1]);
  const y = Math.hypot(matrix[2], matrix[3]);
  const dot = matrix[0] * matrix[2] + matrix[1] * matrix[3];
  if (Math.abs(x - y) > EPSILON * Math.max(1, x, y) ||
      Math.abs(dot) > EPSILON * Math.max(1, x * y)) {
    fail("nonuniform canvas transforms are not supported for strokes or gradients");
  }
  return x;
}

class LinearGradient {
  constructor(start, end) {
    this.start = start;
    this.end = end;
    this.stops = [];
  }

  addColorStop(offset, color) {
    finite(offset, "gradient stop offset");
    if (offset < 0 || offset > 1) fail("gradient stop offsets must be between zero and one");
    this.stops.push({offset, color: rgba(color)});
  }
}

/**
 * Reject unsupported scene content before CanvasRenderer can skip unloaded
 * images or produce rasterized gradient patterns. Only `items` are traversed;
 * live scenegraph parent links intentionally remain untouched.
 */
export function validateTikzScenegraph(root) {
  const pending = [{node: root, marktype: null}];
  while (pending.length) {
    const {node, marktype: parentType} = pending.pop();
    if (!node || typeof node !== "object") fail("invalid scenegraph node");
    const marktype = node.marktype || parentType;
    if (node.marktype && !MARKS.has(node.marktype)) {
      fail(node.marktype === "image" ? "image marks are not supported" : `unsupported mark type: ${node.marktype}`);
    }
    if (node.blend && node.blend !== "source-over") fail(`blend mode ${JSON.stringify(node.blend)} is not supported`);
    if (marktype === "text" && node.stroke) fail("stroked text is not supported");
    for (const paint of ["fill", "stroke"]) {
      const gradient = node[paint];
      if (!gradient || typeof gradient !== "object") continue;
      if (paint === "stroke") fail("gradient strokes are not supported");
      if (marktype === "text") fail("gradient text is not supported");
      if (gradient.gradient !== "linear") fail("radial gradients are not supported");
      const x1 = gradient.x1 ?? 0, y1 = gradient.y1 ?? 0;
      const x2 = gradient.x2 ?? 1, y2 = gradient.y2 ?? 0;
      if (x1 !== x2 && y1 !== y2 && node.bounds && node.bounds.width() !== node.bounds.height()) {
        fail("diagonal gradients in nonsquare bounds require a raster pattern and are not supported");
      }
    }
    if (node.items) {
      for (const child of node.items) pending.push({node: child, marktype});
    }
  }
}

/**
 * Create an external CanvasRenderer context. Pass it to
 * `await view.toCanvas(1, {externalContext: context})`, then call
 * `context.toTikz(width, height)` with the final display dimensions in pixels.
 * The output needs `\\usepackage{tikz}`; export itself never invokes TeX.
 */
export function createTikzContext(options = {}) {
  if (!options || typeof options !== "object") fail("options must be an object");
  const textMode = options.textMode ?? "plain";
  if (textMode !== "plain" && textMode !== "raw") fail("textMode must be 'plain' or 'raw'");
  return new TikzContext(textMode);
}

class TikzContext {
  constructor(textMode) {
    this.textMode = textMode;
    this.fillStyle = "black";
    this.strokeStyle = "black";
    this.globalAlpha = 1;
    this.globalCompositeOperation = "source-over";
    this.lineWidth = 1;
    this.lineCap = "butt";
    this.lineJoin = "miter";
    this.miterLimit = 10;
    this.lineDashOffset = 0;
    this.font = "10px sans-serif";
    this.textAlign = "left";
    this.textBaseline = "alphabetic";
    this.pixelRatio = 1;
    this._matrix = [1, 0, 0, 1, 0, 0];
    this._dash = [];
    this._stack = [];
    this._output = [];
    this._gradientCount = 0;
    this.beginPath();
  }

  save() {
    const state = {};
    for (const key of ["fillStyle", "strokeStyle", "globalAlpha", "globalCompositeOperation",
      "lineWidth", "lineCap", "lineJoin", "miterLimit", "lineDashOffset", "font", "textAlign", "textBaseline"]) {
      state[key] = this[key];
    }
    state.matrix = this._matrix.slice();
    state.dash = this._dash.slice();
    this._stack.push(state);
    this._output.push("\\begin{pgfscope}");
  }

  restore() {
    const state = this._stack.pop();
    if (!state) return; // Canvas restore on an empty stack is a no-op.
    this._matrix = state.matrix;
    this._dash = state.dash;
    delete state.matrix; delete state.dash;
    Object.assign(this, state);
    this._output.push("\\end{pgfscope}");
  }

  transform(a, b, c, d, e, f) {
    for (const value of [a, b, c, d, e, f]) finite(value, "transform component");
    const m = this._matrix;
    this._matrix = [
      m[0] * a + m[2] * b, m[1] * a + m[3] * b,
      m[0] * c + m[2] * d, m[1] * c + m[3] * d,
      m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5],
    ];
    this._matrix.forEach(value => finite(value, "transform component"));
  }

  translate(x, y) { this.transform(1, 0, 0, 1, x, y); }
  scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }
  rotate(angle) {
    finite(angle, "rotation");
    const c = Math.cos(angle), s = Math.sin(angle);
    this.transform(c, s, -s, c, 0, 0);
  }

  beginPath() {
    this._path = [];
    this._current = null;
    this._start = null;
    this._bounds = [Infinity, Infinity, -Infinity, -Infinity];
  }

  _include(x, y) {
    const b = this._bounds;
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
  }

  _append(command, values) {
    this._path.push([command, ...values]);
    for (let i = 0; i < values.length; i += 2) this._include(values[i], values[i + 1]);
    if (values.length) this._current = values.slice(-2);
  }

  moveTo(x, y) {
    const p = transformPoint(this._matrix, x, y);
    this._append("M", p);
    this._start = p;
  }

  lineTo(x, y) {
    if (!this._current) return this.moveTo(x, y);
    this._append("L", transformPoint(this._matrix, x, y));
  }

  bezierCurveTo(x1, y1, x2, y2, x, y) {
    if (!this._current) this.moveTo(x1, y1);
    this._append("C", [
      ...transformPoint(this._matrix, x1, y1),
      ...transformPoint(this._matrix, x2, y2),
      ...transformPoint(this._matrix, x, y),
    ]);
  }

  quadraticCurveTo(x1, y1, x, y) {
    if (!this._current) this.moveTo(x1, y1);
    const start = this._current;
    const control = transformPoint(this._matrix, x1, y1);
    const end = transformPoint(this._matrix, x, y);
    this._append("C", [
      start[0] + 2 * (control[0] - start[0]) / 3,
      start[1] + 2 * (control[1] - start[1]) / 3,
      end[0] + 2 * (control[0] - end[0]) / 3,
      end[1] + 2 * (control[1] - end[1]) / 3,
      ...end,
    ]);
  }

  closePath() {
    if (!this._current) return;
    this._path.push(["Z"]);
    this._current = this._start;
  }

  rect(x, y, width, height) {
    for (const value of [x, y, width, height]) finite(value);
    this.moveTo(x, y);
    this.lineTo(x + width, y);
    this.lineTo(x + width, y + height);
    this.lineTo(x, y + height);
    this.closePath();
  }

  arc(x, y, radius, start, end, anticlockwise = false) {
    for (const value of [x, y, radius, start, end]) finite(value);
    if (radius < 0) fail("arc radius must not be negative");
    const sx = x + radius * Math.cos(start), sy = y + radius * Math.sin(start);
    const p = transformPoint(this._matrix, sx, sy);
    if (!this._current) this.moveTo(sx, sy);
    else if (Math.hypot(p[0] - this._current[0], p[1] - this._current[1]) > EPSILON) this.lineTo(sx, sy);
    const difference = finite(end - start, "arc angle difference");
    const delta = anticlockwise
      ? (difference <= -TAU ? -TAU : -(((-difference % TAU) + TAU) % TAU))
      : (difference >= TAU ? TAU : ((difference % TAU) + TAU) % TAU);
    if (!radius || !delta) return;
    const count = Math.ceil(Math.abs(delta) / (Math.PI / 2));
    for (let i = 0; i < count; ++i) {
      const a = start + delta * i / count, b = start + delta * (i + 1) / count;
      const k = 4 / 3 * Math.tan((b - a) / 4);
      this.bezierCurveTo(
        x + radius * (Math.cos(a) - k * Math.sin(a)),
        y + radius * (Math.sin(a) + k * Math.cos(a)),
        x + radius * (Math.cos(b) + k * Math.sin(b)),
        y + radius * (Math.sin(b) - k * Math.cos(b)),
        x + radius * Math.cos(b), y + radius * Math.sin(b),
      );
    }
  }

  _pathCode() {
    return this._path.map(([command, ...p]) => {
      if (command === "M") return `\\pgfpathmoveto{${point(p[0], p[1])}}`;
      if (command === "L") return `\\pgfpathlineto{${point(p[0], p[1])}}`;
      if (command === "C") return `\\pgfpathcurveto{${point(p[0], p[1])}}{${point(p[2], p[3])}}{${point(p[4], p[5])}}`;
      return "\\pgfpathclose";
    });
  }

  _checkPaint() {
    if (this.globalCompositeOperation !== "source-over") fail(`blend mode ${JSON.stringify(this.globalCompositeOperation)} is not supported`);
    return opacity(this.globalAlpha);
  }

  _solidStyle(paint, kind, alpha) {
    const color = rgba(paint);
    return {alpha: alpha * color.alpha, commands: [
      `\\definecolor{vlctikzcolor}{rgb}{${rgbString(color)}}`,
      `\\pgfset${kind}color{vlctikzcolor}`,
      `\\pgfset${kind}opacity{${number(alpha * color.alpha)}}`,
    ]};
  }

  fill(rule = "nonzero") {
    if (rule !== "nonzero" && rule !== "evenodd") fail("unsupported fill rule");
    const alpha = this._checkPaint();
    if (!alpha || !this._path.length) return;
    if (this.fillStyle instanceof LinearGradient) return this._fillGradient(this.fillStyle, alpha, rule);
    const style = this._solidStyle(this.fillStyle, "fill", alpha);
    if (!style.alpha) return;
    this._output.push("\\begin{pgfscope}", ...style.commands,
      rule === "evenodd" ? "\\pgfseteorule" : "\\pgfsetnonzerorule",
      ...this._pathCode(), "\\pgfusepath{fill}", "\\end{pgfscope}");
  }

  stroke() {
    const alpha = this._checkPaint();
    if (!alpha || !this._path.length) return;
    if (this.strokeStyle instanceof LinearGradient) fail("gradient strokes are not supported");
    const style = this._solidStyle(this.strokeStyle, "stroke", alpha);
    if (!style.alpha) return;
    const width = finite(this.lineWidth, "stroke width");
    if (width <= 0) fail("stroke width must be positive");
    const scale = uniformScale(this._matrix);
    if (scale === 0) return;
    const caps = {butt: "butt", round: "round", square: "rect"};
    const joins = {miter: "miter", round: "round", bevel: "bevel"};
    if (!Object.hasOwn(caps, this.lineCap) || !Object.hasOwn(joins, this.lineJoin)) fail("unsupported line cap or join");
    const limit = finite(this.miterLimit, "miter limit");
    if (limit <= 0) fail("miter limit must be positive");
    const dash = this._dash.map(value => `{${length(value * scale)}}`).join("");
    this._output.push("\\begin{pgfscope}", ...style.commands,
      `\\pgfsetlinewidth{${length(width * scale)}}`,
      `\\pgfset${caps[this.lineCap]}cap`, `\\pgfset${joins[this.lineJoin]}join`,
      `\\pgfsetmiterlimit{${number(limit)}}`,
      `\\pgfsetdash{${dash}}{${length(finite(this.lineDashOffset, "dash offset") * scale)}}`,
      ...this._pathCode(), "\\pgfusepath{stroke}", "\\end{pgfscope}");
  }

  clip(rule = "nonzero") {
    if (rule !== "nonzero" && rule !== "evenodd") fail("unsupported clip rule");
    this._output.push(rule === "evenodd" ? "\\pgfseteorule" : "\\pgfsetnonzerorule",
      ...this._pathCode(), "\\pgfusepath{clip}");
  }

  fillRect(x, y, width, height) {
    const path = this._path, current = this._current, start = this._start, bounds = this._bounds;
    this.beginPath();
    this.rect(x, y, width, height);
    this.fill();
    this._path = path; this._current = current; this._start = start; this._bounds = bounds;
  }

  setLineDash(values) {
    if (!Array.isArray(values)) fail("stroke dash must be an array");
    values.forEach(value => {
      finite(value, "dash length");
      if (value < 0) fail("dash lengths must not be negative");
    });
    // Canvas repeats an odd dash list and treats all-zero lists as solid.
    this._dash = values.every(value => value === 0) ? []
      : values.length % 2 ? [...values, ...values] : values.slice();
  }

  getLineDash() { return this._dash.slice(); }

  fillText(value, x, y, maxWidth) {
    if (maxWidth != null) fail("canvas maxWidth text scaling is not supported");
    const alpha = this._checkPaint();
    if (!alpha || value === "") return;
    if (this.fillStyle instanceof LinearGradient) fail("gradient text is not supported");
    const color = rgba(this.fillStyle);
    if (!color.alpha) return;
    if (this.textBaseline !== "alphabetic") fail("expected Vega's alphabetic text baseline");
    const anchors = {left: "left", start: "left", center: "center", right: "right", end: "right"};
    if (!Object.hasOwn(anchors, this.textAlign)) fail("unsupported text alignment");
    const text = this.textMode === "raw" ? String(value) : escapeText(String(value));
    const font = fontCommands(this.font);
    const p = transformPoint(this._matrix, x, y);
    const [a, b, c, d] = this._matrix;
    if (a * d - b * c === 0) return;
    // Invert the canvas y axis while keeping glyphs upright. pgftext honors
    // the current affine transform, including text rotation and render scale.
    this._output.push("\\begin{pgfscope}",
      `\\pgfsetfillopacity{${number(alpha * color.alpha)}}`,
      `\\pgftransformcm{${number(a)}}{${number(-b)}}{${number(-c)}}{${number(d)}}{${point(p[0], p[1])}}`,
      `\\pgftext[${anchors[this.textAlign]},base]{${font}\\color[rgb]{${rgbString(color)}} ${text}}`,
      "\\end{pgfscope}");
  }

  createLinearGradient(x1, y1, x2, y2) {
    uniformScale(this._matrix);
    return new LinearGradient(transformPoint(this._matrix, x1, y1), transformPoint(this._matrix, x2, y2));
  }

  _fillGradient(gradient, alpha, rule) {
    const stops = gradient.stops.slice().sort((a, b) => a.offset - b.offset);
    if (!stops.length) return;
    const stopAlpha = stops[0].color.alpha;
    for (let i = 0; i < stops.length; ++i) {
      if (Math.abs(stops[i].color.alpha - stopAlpha) > EPSILON) fail("linear gradients with varying stop opacity are not supported");
      if (i && stops[i].offset === stops[i - 1].offset) fail("linear gradients with repeated stop offsets are not supported");
    }
    if (!stopAlpha) return;
    const [x, y] = gradient.start;
    const dx = gradient.end[0] - x, dy = gradient.end[1] - y;
    const size = Math.hypot(dx, dy);
    if (!size) return; // Canvas zero-length gradients paint nothing.
    const ex = dx / size, ey = dy / size, nx = -ey, ny = ex;
    const b = this._bounds;
    const corners = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
    const s = corners.map(([cx, cy]) => (cx - x) * ex + (cy - y) * ey);
    const t = corners.map(([cx, cy]) => (cx - x) * nx + (cy - y) * ny);
    const smin = Math.min(0, ...s), smax = Math.max(size, ...s);
    const tmin = Math.min(...t), tmax = Math.max(...t);
    if (!(tmax > tmin) || !(smax > smin)) return;
    const entries = stops.map(stop => ({position: stop.offset * size - smin, color: stop.color}));
    const width = smax - smin, height = tmax - tmin;
    if (entries[0].position > 0) entries.unshift({position: 0, color: entries[0].color});
    if (entries[entries.length - 1].position < width) entries.push({position: width, color: entries[entries.length - 1].color});
    // A single stop has a constant color, so the added end stops still give a
    // valid two-point shading. Names are unique to this PGF picture.
    const name = `vlctikz-\\pgfpictureid-${++this._gradientCount}`;
    const definition = entries.map(entry => `rgb(${length(entry.position)})=(${rgbString(entry.color)})`).join("; ");
    const center = [x + ex * (smin + smax) / 2 + nx * (tmin + tmax) / 2,
      y + ey * (smin + smax) / 2 + ny * (tmin + tmax) / 2];
    this._output.push("\\begin{pgfscope}",
      `\\pgfsetfillopacity{${number(alpha * stopAlpha)}}`,
      rule === "evenodd" ? "\\pgfseteorule" : "\\pgfsetnonzerorule",
      ...this._pathCode(), "\\pgfusepath{clip}",
      `\\pgfdeclarehorizontalshading{${name}}{${length(height)}}{${definition}}`,
      `\\pgftransformcm{${number(ex)}}{${number(-ey)}}{${number(nx)}}{${number(-ny)}}{${point(center[0], center[1])}}`,
      "\\pgflowlevelsynccm", `\\pgfuseshading{${name}}`, "\\end{pgfscope}");
  }

  strokeText() { fail("stroked text is not supported"); }
  drawImage() { fail("image marks are not supported"); }
  createRadialGradient() { fail("radial gradients are not supported"); }
  createPattern() { fail("raster patterns, including diagonal gradients in nonsquare bounds, are not supported"); }
  clearRect() { fail("clearing an existing drawing is not supported"); }

  toTikz(width, height) {
    finite(width, "display width"); finite(height, "display height");
    if (width < 0 || height < 0) fail("display dimensions must not be negative");
    if (this._stack.length) fail("unbalanced canvas save/restore calls");
    const box = `\\pgfpathrectangle{${point(0, height)}}{\\pgfpoint{${length(width)}}{${length(height)}}}`;
    const lines = [
      "% Generated by vl-convert. Requires \\usepackage{tikz}.",
      "% Geometry is fixed by Vega; text inherits the surrounding TeX font family.",
      "\\begin{tikzpicture}", "\\begin{pgfscope}",
      box, "\\pgfusepath{clip}", ...this._output, "\\end{pgfscope}",
      "\\pgfresetboundingbox", box, "\\pgfusepath{use as bounding box}", "\\end{tikzpicture}",
    ];
    return lines.map(line => line.startsWith("%") ? line : `${line}%`).join("\n") + "\n";
  }
}
