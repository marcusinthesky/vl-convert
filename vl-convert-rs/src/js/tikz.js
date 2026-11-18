// Vega's CanvasRenderer supplies the geometry, paint order, clipping, and text
// baselines. This context implements the Canvas operations that renderer uses
// and emits PGF drawing commands inside a tikzpicture. It never reads chart data,
// scales, or axis definitions. Unsupported drawing effects fail explicitly.
import {color as parseColor} from "https://cdn.jsdelivr.net/npm/d3-color@3.1.0/+esm";

const PX_TO_BP = 0.75;
const TAU = 2 * Math.PI;
const EPSILON = 1e-10;
const MARKS = new Set([
  "arc", "area", "group", "line", "path", "rect", "rule", "shape", "symbol", "text", "trail",
]);
const CANVAS_STATE_PROPERTIES = [
  "fillStyle", "strokeStyle", "globalAlpha", "globalCompositeOperation",
  "lineWidth", "lineCap", "lineJoin", "miterLimit", "lineDashOffset", "font", "textAlign", "textBaseline",
];

// PGF serialization: dimensions are CSS pixels until converted here. Canvas y
// increases downwards; PGF y increases upwards.

function fail(message) {
  throw new Error(`TikZ export: ${message}`);
}

function finite(value, name = "coordinate") {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${name} must be a finite number`);
  }
  return value;
}

function pgfNumber(value) {
  finite(value);
  // TeX dimensions do not accept JavaScript's exponential number notation.
  if (Math.abs(value) > 1e8) fail("numeric value exceeds the supported TeX range");
  return Number(value.toFixed(6)).toString();
}

function pgfLength(px) {
  const bp = finite(px) * PX_TO_BP;
  // Keep within TeX's dimension limit, including the bp -> pt conversion.
  if (Math.abs(bp) > 16000) fail("drawing exceeds TeX's maximum dimension");
  return `${pgfNumber(bp)}bp`;
}

function pgfPoint(x, y) {
  return `\\pgfpoint{${pgfLength(x)}}{${pgfLength(-y)}}`;
}

function opacity(value) {
  finite(value, "opacity");
  if (value < 0 || value > 1) fail("opacity must be between zero and one");
  return value;
}

function parseCssColor(value) {
  if (typeof value !== "string") fail("paint must be a CSS color or a supported linear gradient");
  const parsed = parseColor(value);
  if (!parsed) fail(`unsupported CSS color: ${JSON.stringify(value)}`);
  const rgb = parsed.rgb();
  const alpha = Math.max(0, Math.min(1, rgb.opacity));
  // d3-color represents transparent with NaN color components.
  const channel = v => alpha === 0 ? 0 : Math.max(0, Math.min(255, finite(v, "color component"))) / 255;
  return {r: channel(rgb.r), g: channel(rgb.g), b: channel(rgb.b), alpha};
}

function pgfRgb(color) {
  return [color.r, color.g, color.b].map(pgfNumber).join(",");
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
  return `\\${bold ? "bf" : "md"}series\\${shape}shape\\fontsize{${pgfLength(size)}}{${pgfLength(size * 1.2)}}\\selectfont`;
}

function transformPoint(matrix, x, y) {
  finite(x); finite(y);
  return [
    finite(matrix[0] * x + matrix[2] * y + matrix[4]),
    finite(matrix[1] * x + matrix[3] * y + matrix[5]),
  ];
}

function uniformScale(matrix) {
  const scaleX = Math.hypot(matrix[0], matrix[1]);
  const scaleY = Math.hypot(matrix[2], matrix[3]);
  const dot = matrix[0] * matrix[2] + matrix[1] * matrix[3];
  if (Math.abs(scaleX - scaleY) > EPSILON * Math.max(1, scaleX, scaleY) ||
      Math.abs(dot) > EPSILON * Math.max(1, scaleX * scaleY)) {
    fail("nonuniform canvas transforms are not supported for strokes or gradients");
  }
  return scaleX;
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
    this.stops.push({offset, color: parseCssColor(color)});
  }
}

// PGF horizontal shadings are finite rectangles. Project the path bounds onto
// the gradient's axis and its perpendicular, then extend the endpoint colors
// to cover that rectangle. Clipping during painting supplies the actual shape.
function linearShading(gradient, bounds) {
  const stops = gradient.stops.slice().sort((a, b) => a.offset - b.offset);
  if (!stops.length) return null;
  const alpha = stops[0].color.alpha;
  for (let i = 0; i < stops.length; ++i) {
    if (Math.abs(stops[i].color.alpha - alpha) > EPSILON) fail("linear gradients with varying stop opacity are not supported");
    if (i && stops[i].offset === stops[i - 1].offset) fail("linear gradients with repeated stop offsets are not supported");
  }
  if (!alpha) return null;
  const [x, y] = gradient.start;
  const dx = gradient.end[0] - x, dy = gradient.end[1] - y;
  const size = Math.hypot(dx, dy);
  if (!size) return null; // Canvas zero-length gradients paint nothing.
  const axisX = dx / size, axisY = dy / size;
  const normalX = -axisY, normalY = axisX;
  const [left, top, right, bottom] = bounds;
  const corners = [[left, top], [right, top], [right, bottom], [left, bottom]];
  const along = corners.map(([cx, cy]) => (cx - x) * axisX + (cy - y) * axisY);
  const across = corners.map(([cx, cy]) => (cx - x) * normalX + (cy - y) * normalY);
  const alongMin = Math.min(0, ...along), alongMax = Math.max(size, ...along);
  const acrossMin = Math.min(...across), acrossMax = Math.max(...across);
  if (!(acrossMax > acrossMin) || !(alongMax > alongMin)) return null;
  const entries = stops.map(stop => ({position: stop.offset * size - alongMin, color: stop.color}));
  const width = alongMax - alongMin;
  if (entries[0].position > 0) entries.unshift({position: 0, color: entries[0].color});
  if (entries[entries.length - 1].position < width) entries.push({position: width, color: entries[entries.length - 1].color});
  // A single color stop also becomes a valid two-point constant shading.
  return {
    alpha, height: acrossMax - acrossMin, stops: entries,
    axis: [axisX, axisY], normal: [normalX, normalY],
    center: [
      x + axisX * (alongMin + alongMax) / 2 + normalX * (acrossMin + acrossMax) / 2,
      y + axisY * (alongMin + alongMax) / 2 + normalY * (acrossMin + acrossMax) / 2,
    ],
  };
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

  // Canvas state and transforms. The current path is not part of saved state;
  // PGF scopes separately preserve clipping and other already-emitted state.
  save() {
    const state = {};
    for (const key of CANVAS_STATE_PROPERTIES) {
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

  // Paths are stored in display coordinates at construction time. Vega may
  // undo a mark's transform before calling fill/stroke. Keep the path for reuse:
  // Canvas can fill and stroke it, while each PGF usepath consumes its copy.
  beginPath() {
    this._path = [];
    this._currentPoint = null;
    this._subpathStart = null;
    this._pathBounds = [Infinity, Infinity, -Infinity, -Infinity];
  }

  _includePoint(x, y) {
    const bounds = this._pathBounds;
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
  }

  _appendPath(command, values) {
    this._path.push([command, ...values]);
    // Including Bezier control points gives conservative bounds for shading.
    for (let i = 0; i < values.length; i += 2) this._includePoint(values[i], values[i + 1]);
    if (values.length) this._currentPoint = values.slice(-2);
  }

  moveTo(x, y) {
    const position = transformPoint(this._matrix, x, y);
    this._appendPath("M", position);
    this._subpathStart = position;
  }

  lineTo(x, y) {
    if (!this._currentPoint) return this.moveTo(x, y);
    this._appendPath("L", transformPoint(this._matrix, x, y));
  }

  bezierCurveTo(x1, y1, x2, y2, x, y) {
    if (!this._currentPoint) this.moveTo(x1, y1);
    this._appendPath("C", [
      ...transformPoint(this._matrix, x1, y1),
      ...transformPoint(this._matrix, x2, y2),
      ...transformPoint(this._matrix, x, y),
    ]);
  }

  quadraticCurveTo(x1, y1, x, y) {
    if (!this._currentPoint) this.moveTo(x1, y1);
    const start = this._currentPoint;
    const control = transformPoint(this._matrix, x1, y1);
    const end = transformPoint(this._matrix, x, y);
    this._appendPath("C", [
      start[0] + 2 * (control[0] - start[0]) / 3,
      start[1] + 2 * (control[1] - start[1]) / 3,
      end[0] + 2 * (control[0] - end[0]) / 3,
      end[1] + 2 * (control[1] - end[1]) / 3,
      ...end,
    ]);
  }

  closePath() {
    if (!this._currentPoint) return;
    this._path.push(["Z"]);
    this._currentPoint = this._subpathStart;
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
    if (!this._currentPoint) this.moveTo(sx, sy);
    else if (Math.hypot(p[0] - this._currentPoint[0], p[1] - this._currentPoint[1]) > EPSILON) this.lineTo(sx, sy);
    const difference = finite(end - start, "arc angle difference");
    const delta = anticlockwise
      ? (difference <= -TAU ? -TAU : -(((-difference % TAU) + TAU) % TAU))
      : (difference >= TAU ? TAU : ((difference % TAU) + TAU) % TAU);
    if (!radius || !delta) return;
    // Approximate each arc segment with a cubic, using at most a quarter turn.
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

  _pathCommands() {
    return this._path.map(([command, ...coordinates]) => {
      if (command === "M") return `\\pgfpathmoveto{${pgfPoint(coordinates[0], coordinates[1])}}`;
      if (command === "L") return `\\pgfpathlineto{${pgfPoint(coordinates[0], coordinates[1])}}`;
      if (command === "C") return `\\pgfpathcurveto{${pgfPoint(coordinates[0], coordinates[1])}}{${pgfPoint(coordinates[2], coordinates[3])}}{${pgfPoint(coordinates[4], coordinates[5])}}`;
      return "\\pgfpathclose";
    });
  }

  // Painting replays the stored path and composes Vega's alpha with CSS alpha.
  _paintOpacity() {
    if (this.globalCompositeOperation !== "source-over") fail(`blend mode ${JSON.stringify(this.globalCompositeOperation)} is not supported`);
    return opacity(this.globalAlpha);
  }

  _solidStyle(paint, kind, alpha) {
    const color = parseCssColor(paint);
    return {alpha: alpha * color.alpha, commands: [
      `\\definecolor{vlctikzcolor}{rgb}{${pgfRgb(color)}}`,
      `\\pgfset${kind}color{vlctikzcolor}`,
      `\\pgfset${kind}opacity{${pgfNumber(alpha * color.alpha)}}`,
    ]};
  }

  fill(rule = "nonzero") {
    if (rule !== "nonzero" && rule !== "evenodd") fail("unsupported fill rule");
    const alpha = this._paintOpacity();
    if (!alpha || !this._path.length) return;
    if (this.fillStyle instanceof LinearGradient) return this._fillGradient(this.fillStyle, alpha, rule);
    const style = this._solidStyle(this.fillStyle, "fill", alpha);
    if (!style.alpha) return;
    this._output.push("\\begin{pgfscope}", ...style.commands,
      rule === "evenodd" ? "\\pgfseteorule" : "\\pgfsetnonzerorule",
      ...this._pathCommands(), "\\pgfusepath{fill}", "\\end{pgfscope}");
  }

  stroke() {
    const alpha = this._paintOpacity();
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
    const dash = this._dash.map(value => `{${pgfLength(value * scale)}}`).join("");
    this._output.push("\\begin{pgfscope}", ...style.commands,
      `\\pgfsetlinewidth{${pgfLength(width * scale)}}`,
      `\\pgfset${caps[this.lineCap]}cap`, `\\pgfset${joins[this.lineJoin]}join`,
      `\\pgfsetmiterlimit{${pgfNumber(limit)}}`,
      `\\pgfsetdash{${dash}}{${pgfLength(finite(this.lineDashOffset, "dash offset") * scale)}}`,
      ...this._pathCommands(), "\\pgfusepath{stroke}", "\\end{pgfscope}");
  }

  clip(rule = "nonzero") {
    if (rule !== "nonzero" && rule !== "evenodd") fail("unsupported clip rule");
    this._output.push(rule === "evenodd" ? "\\pgfseteorule" : "\\pgfsetnonzerorule",
      ...this._pathCommands(), "\\pgfusepath{clip}");
  }

  fillRect(x, y, width, height) {
    const path = this._path, current = this._currentPoint, start = this._subpathStart, bounds = this._pathBounds;
    this.beginPath();
    this.rect(x, y, width, height);
    this.fill();
    this._path = path; this._currentPoint = current; this._subpathStart = start; this._pathBounds = bounds;
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

  // Text uses Vega's already-computed baseline, alignment, and line breaks.
  // TeX selects the glyphs; their widths do not feed back into Vega's layout.
  fillText(value, x, y, maxWidth) {
    if (maxWidth != null) fail("canvas maxWidth text scaling is not supported");
    const alpha = this._paintOpacity();
    if (!alpha || value === "") return;
    if (this.fillStyle instanceof LinearGradient) fail("gradient text is not supported");
    const color = parseCssColor(this.fillStyle);
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
      `\\pgfsetfillopacity{${pgfNumber(alpha * color.alpha)}}`,
      `\\pgftransformcm{${pgfNumber(a)}}{${pgfNumber(-b)}}{${pgfNumber(-c)}}{${pgfNumber(d)}}{${pgfPoint(p[0], p[1])}}`,
      `\\pgftext[${anchors[this.textAlign]},base]{${font}\\color[rgb]{${pgfRgb(color)}} ${text}}`,
      "\\end{pgfscope}");
  }

  createLinearGradient(x1, y1, x2, y2) {
    // Canvas gradients retain the transform in effect when they are created.
    uniformScale(this._matrix);
    return new LinearGradient(transformPoint(this._matrix, x1, y1), transformPoint(this._matrix, x2, y2));
  }

  _fillGradient(gradient, alpha, rule) {
    const shading = linearShading(gradient, this._pathBounds);
    if (!shading) return;
    const {height, center, axis: [axisX, axisY], normal: [normalX, normalY]} = shading;
    // Names must remain distinct when a document includes multiple figures.
    const name = `vlctikz-\\pgfpictureid-${++this._gradientCount}`;
    const definition = shading.stops.map(stop => `rgb(${pgfLength(stop.position)})=(${pgfRgb(stop.color)})`).join("; ");
    this._output.push("\\begin{pgfscope}",
      `\\pgfsetfillopacity{${pgfNumber(alpha * shading.alpha)}}`,
      rule === "evenodd" ? "\\pgfseteorule" : "\\pgfsetnonzerorule",
      ...this._pathCommands(), "\\pgfusepath{clip}",
      `\\pgfdeclarehorizontalshading{${name}}{${pgfLength(height)}}{${definition}}`,
      `\\pgftransformcm{${pgfNumber(axisX)}}{${pgfNumber(-axisY)}}{${pgfNumber(normalX)}}{${pgfNumber(-normalY)}}{${pgfPoint(center[0], center[1])}}`,
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
    // Clip to Vega's viewport and then reset PGF's accumulated bounds, including
    // invisible control points and text extents, to that exact display size.
    const box = `\\pgfpathrectangle{${pgfPoint(0, height)}}{\\pgfpoint{${pgfLength(width)}}{${pgfLength(height)}}}`;
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
