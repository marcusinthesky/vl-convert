// Shared real-Vega fixtures for renderer tests and optional TeX visual checks.
import {readFile} from 'node:fs/promises';
import * as vega from '/npm/vega@6.4.0/+esm';
import * as vegaLite from '/npm/vega-lite@6.4.3/+esm';
import {createTikzContext, validateTikzScenegraph} from '../../src/js/tikz.js';

export const fixtures = [
  {name: 'bars', kind: 'vl'},
  {name: 'curves', kind: 'vl'},
  {name: 'facet', kind: 'vl'},
  {name: 'repeat', kind: 'vl'},
  {name: 'concat', kind: 'vl'},
  {name: 'primitives', kind: 'vg'},
  {name: 'text', kind: 'vg'},
  {name: 'math', kind: 'vg', textMode: 'raw'},
  {name: 'gradient', kind: 'vg'},
];

export async function loadFixture(name) {
  const fixture = fixtures.find(item => item.name === name);
  if (!fixture) throw new Error(`Unknown TikZ fixture: ${name}`);
  const filename = `${fixture.name}.${fixture.kind}.json`;
  const spec = JSON.parse(await readFile(new URL(filename, import.meta.url), 'utf8'));
  return {...fixture, spec};
}

export function collectMarks(node, marktype) {
  const result = [];
  const visit = item => {
    if (item.marktype === marktype) result.push(item);
    for (const child of item.items || []) visit(child);
  };
  visit(node);
  return result;
}

export async function renderSpec(spec, {kind = 'vg', textMode = 'plain', svg = false} = {}) {
  const vgSpec = kind === 'vl' ? vegaLite.compile(spec).spec : spec;
  const view = new vega.View(vega.parse(vgSpec), {renderer: 'none'});
  try {
    await view.runAsync();
    const scenegraph = view.scenegraph().root;
    validateTikzScenegraph(scenegraph);
    const context = createTikzContext({textMode});
    const calls = [];
    // Observe the public drawing boundary, without accessing adapter internals.
    for (const method of ['fill', 'stroke', 'fillText', 'clip', 'arc', 'bezierCurveTo',
      'quadraticCurveTo', 'moveTo', 'lineTo', 'translate', 'rotate', 'createLinearGradient']) {
      const original = context[method].bind(context);
      context[method] = (...args) => {
        calls.push({method, args, fillStyle: context.fillStyle, strokeStyle: context.strokeStyle});
        return original(...args);
      };
    }
    await view.toCanvas(1, {externalContext: context});
    const padding = view.padding();
    const width = Math.max(0, view._viewWidth + padding.left + padding.right);
    const height = Math.max(0, view._viewHeight + padding.top + padding.bottom);
    const origin = [padding.left + view._origin[0], padding.top + view._origin[1]];
    return {
      tikz: context.toTikz(width, height),
      svg: svg ? await view.toSVG() : undefined,
      width, height, origin, calls, scenegraph, vgSpec,
    };
  } finally {
    view.finalize();
  }
}

export async function renderFixture(name, options = {}) {
  const fixture = await loadFixture(name);
  return renderSpec(fixture.spec, {...fixture, ...options});
}
