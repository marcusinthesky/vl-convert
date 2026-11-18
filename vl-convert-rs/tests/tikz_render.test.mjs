import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {color} from '/npm/d3-color@3.1.0/+esm';
import {collectMarks, fixtures, loadFixture, renderFixture, renderSpec} from './tikz/helpers.mjs';

const count = (text, token) => text.split(token).length - 1;
const marks = (result, type) => collectMarks(result.scenegraph, type).filter(mark => mark.role === 'mark');
const items = (result, type) => marks(result, type).flatMap(mark => mark.items);
const paint = css => {
  const rgb = color(css).rgb();
  return `\\definecolor{vlctikzcolor}{rgb}{${[rgb.r, rgb.g, rgb.b].map(v => +((v / 255).toFixed(6))).join(',')}}`;
};

for (const fixture of fixtures) {
  test(`${fixture.name}: complete drawing has finite dimensions and stable output`, async () => {
    const first = await renderFixture(fixture.name, {svg: true});
    const second = await renderFixture(fixture.name);
    assert.ok(first.width > 0 && Number.isFinite(first.width));
    assert.ok(first.height > 0 && Number.isFinite(first.height));
    assert.equal(first.tikz, second.tikz);
    assert.equal(count(first.tikz, '\\begin{pgfscope}'), count(first.tikz, '\\end{pgfscope}'));
    assert.doesNotMatch(first.tikz, /(?:NaN|Infinity)bp/);
    assert.ok(first.svg.includes(`width="${first.width}"`));
    assert.ok(first.svg.includes(`height="${first.height}"`));
    assert.equal(count(first.tikz, '\\pgftext['), first.calls.filter(c => c.method === 'fillText').length);
    assert.ok(first.tikz.includes(`\\pgfpoint{${first.width * 0.75}bp}{${first.height * 0.75}bp}`));
    assert.equal(count(first.tikz, '\\pgfusepath{use as bounding box}'), 1);
  });
}

test('Vega padding/origin is applied once and y coordinates are inverted', async () => {
  const result = await renderSpec({
    width: 100, height: 50, padding: {left: 7, top: 11, right: 13, bottom: 17}, autosize: 'none',
    marks: [{type: 'rect', encode: {enter: {
      x: {value: 10}, y: {value: 12}, width: {value: 20}, height: {value: 16}, fill: {value: 'red'},
    }}}],
  });
  assert.deepEqual(result.origin, [7, 11]);
  assert.deepEqual([result.width, result.height], [120, 78]);
  // The rect's opposite corners are (17,23) and (37,39) CSS px after padding.
  assert.ok(result.tikz.includes('\\pgfpathmoveto{\\pgfpoint{12.75bp}{-17.25bp}}'));
  assert.ok(result.tikz.includes('\\pgfpathlineto{\\pgfpoint{27.75bp}{-29.25bp}}'));
  assert.equal(count(result.tikz, '\\pgfusepath{fill}'), 1);
});

test('rounded bars retain all three data marks and the escaped chart title', async () => {
  const result = await renderFixture('bars');
  assert.equal(items(result, 'rect').length, 3);
  assert.ok(count(result.tikz, '\\pgfpathcurveto') >= 6);
  for (const label of ['Alpha', 'Beta', 'Gamma', 'Estimates \\& uncertainty']) {
    assert.ok(result.tikz.includes(label), label);
  }
  const fill = items(result, 'rect')[0].fill;
  assert.equal(count(result.tikz, paint(fill)), 3);
});

test('line/area interpolation and aggregate reference rule come from Vega', async () => {
  const result = await renderFixture('curves');
  assert.equal(items(result, 'line').length, 6);
  assert.equal(items(result, 'area').length, 6);
  assert.equal(items(result, 'symbol').length, 6);
  const rules = items(result, 'rule');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].datum.mean_y, 3.5);
  assert.ok(count(result.tikz, '\\pgfpathcurveto') >= 15);
  assert.ok(result.tikz.includes('\\pgfsetdash{{3.75bp}{2.25bp}}{0bp}'));
});

test('facets inherit configuration and paint the data bars in both panels', async () => {
  const result = await renderFixture('facet');
  assert.equal(items(result, 'rect').length, 4);
  assert.ok(result.tikz.includes('North'));
  assert.ok(result.tikz.includes('South'));
  const cell = collectMarks(result.scenegraph, 'group').find(mark => mark.name === 'cell');
  assert.equal(cell.items.length, 2);
  assert.notEqual(cell.items[0].x, cell.items[1].x);
  const axisLabels = collectMarks(result.scenegraph, 'text').filter(mark => mark.role === 'axis-label').flatMap(mark => mark.items);
  assert.ok(axisLabels.length > 0 && axisLabels.every(item => item.fontSize === 11));
  assert.ok(count(result.tikz, '\\fontsize{8.25bp}') >= axisLabels.length);
});

test('repeat retains both panels and inherited point color', async () => {
  const result = await renderFixture('repeat');
  const symbols = items(result, 'symbol');
  assert.equal(symbols.length, 8);
  assert.ok(symbols.every(item => item.fill === '#4c956c'));
  assert.equal(count(result.tikz, paint('#4c956c')), 8);
  const panels = collectMarks(result.scenegraph, 'group').filter(mark => mark.name?.startsWith('child__'));
  assert.equal(panels.length, 2);
  assert.notEqual(panels[0].items[0].x, panels[1].items[0].x);
});

test('concat shares position domains and category colors through the evaluated scenegraph', async () => {
  const result = await renderFixture('concat');
  const symbols = items(result, 'symbol');
  assert.equal(symbols.length, 4);
  const b = symbols.filter(item => item.datum.kind === 'B');
  assert.equal(b.length, 2);
  assert.equal(b[0].fill, b[1].fill);
  // A shared x domain [0,10] maps x=3 and x=8 to 36 and 96 in 120px panels.
  assert.deepEqual(b.map(item => item.x), [36, 96]);
  assert.equal(count(result.tikz, paint(b[0].fill)), 3); // two points and one legend swatch
  assert.ok(result.tikz.includes('Left') && result.tikz.includes('Right'));
});

test('native path/arc/trail geometry and nested clipping are retained', async () => {
  const result = await renderFixture('primitives');
  for (const type of ['arc', 'path', 'rule', 'symbol']) assert.equal(items(result, type).length, 1);
  assert.equal(items(result, 'trail').length, 4);
  assert.ok(result.calls.some(call => call.method === 'quadraticCurveTo'));
  assert.ok(result.calls.some(call => call.method === 'arc'));
  assert.ok(result.calls.some(call => call.method === 'rotate'));
  assert.ok(count(result.tikz, '\\pgfpathcurveto') > 25);
  assert.equal(count(result.tikz, '\\pgfusepath{clip}'), 2); // page and group
  assert.ok(result.tikz.includes('\\pgfsetroundcap'));
  assert.ok(result.tikz.includes('Clip \\& dash'));
});

test('multiline/rotated text is emitted once per Vega line with escaping and font styles', async () => {
  const result = await renderFixture('text');
  assert.equal(count(result.tikz, '\\pgftext['), 5);
  for (const label of ['cost\\_50\\% \\& tax \\#1', 'First line', 'Second line', 'Rotated label']) {
    assert.ok(result.tikz.includes(label), label);
  }
  assert.ok(result.tikz.includes('\\bfseries'));
  assert.ok(result.tikz.includes('\\itshape'));
  assert.ok(result.tikz.includes('\\pgftransformcm{0.819152}{0.573576}{-0.573576}{0.819152}'));
  assert.ok(result.calls.some(call => call.method === 'fillText' && call.args[0].endsWith('...')));
});

test('raw math remains explicit and plain mode escapes it', async () => {
  const raw = await renderFixture('math');
  const plain = await renderFixture('math', {textMode: 'plain'});
  assert.ok(raw.tikz.includes('$\\alpha_1 + \\beta_2 = \\gamma$'));
  assert.ok(raw.tikz.includes('\\hat{\\theta}'));
  assert.ok(plain.tikz.includes('\\textbackslash{}alpha\\_1'));
  assert.ok(plain.tikz.includes('\\$'));
});

test('linear gradients use one native shading and three actual color stops', async () => {
  const result = await renderFixture('gradient');
  assert.equal(count(result.tikz, '\\pgfdeclarehorizontalshading'), 1);
  assert.equal(count(result.tikz, '\\pgfuseshading'), 1);
  assert.ok(result.tikz.includes('rgb(0bp)=(0.298039,0.470588,0.658824)'));
  assert.ok(result.tikz.includes('rgb(82.5bp)=(1,1,1)'));
  assert.ok(result.tikz.includes('rgb(165bp)=(0.698039,0.294118,0.27451)'));
});

test('scenegraph z-order controls the output paint order', async () => {
  const result = await renderSpec({
    width: 50, height: 50, padding: 0, autosize: 'none',
    data: [{name: 'd', values: [{color: 'red', z: 2}, {color: 'blue', z: 1}]}],
    marks: [{type: 'rect', from: {data: 'd'}, encode: {enter: {
      x: {value: 5}, y: {value: 5}, width: {value: 20}, height: {value: 20},
      fill: {field: 'color'}, zindex: {field: 'z'},
    }}}],
  });
  assert.ok(result.tikz.indexOf(paint('blue')) < result.tikz.indexOf(paint('red')));
});

test('Vega item, paint and CSS color opacities compose', async () => {
  const result = await renderSpec({
    width: 50, height: 50, padding: 0, autosize: 'none',
    marks: [{type: 'rect', encode: {enter: {
      x: {value: 5}, y: {value: 5}, width: {value: 20}, height: {value: 20},
      fill: {value: 'rgba(255,0,0,0.5)'}, opacity: {value: 0.5}, fillOpacity: {value: 0.4},
    }}}],
  });
  assert.ok(result.tikz.includes('\\pgfsetfillopacity{0.1}'));
});

test('unsupported images fail even if they would not produce a Canvas draw call', async () => {
  await assert.rejects(renderSpec({
    width: 50, height: 50,
    marks: [{type: 'image', encode: {enter: {width: {value: 0}, height: {value: 0}}}}],
  }), /image marks are not supported/);
});

test('unsupported gradients and text paints fail explicitly', async () => {
  const fixture = await loadFixture('gradient');
  const radial = structuredClone(fixture.spec);
  radial.marks[0].encode.enter.fill.value.gradient = 'radial';
  await assert.rejects(renderSpec(radial), /radial gradients are not supported/);
  const diagonal = structuredClone(fixture.spec);
  diagonal.marks[0].encode.enter.fill.value.y2 = 1;
  await assert.rejects(renderSpec(diagonal), /diagonal gradients.*not supported/);
  const stroked = {width: 50, height: 50, marks: [{type: 'text', encode: {enter: {
    text: {value: 'outline'}, stroke: {value: 'red'},
  }}}]};
  await assert.rejects(renderSpec(stroked), /stroked text is not supported/);
});

// Read the generated version inventory so this compatibility check follows the
// compilers actually shipped with vl-convert, rather than a separate version list.
const importMap = await readFile(new URL('../src/module_loader/import_map.rs', import.meta.url), 'utf8');
const compilerPaths = [...new Set([...importMap.matchAll(/v\d+_\d+ => "(\/npm\/vega-lite@[^"\n]+\/\+esm)"/g)].map(match => match[1]))];
assert.ok(compilerPaths.length > 0, 'Bundled compiler inventory must not be empty');
for (const compilerPath of compilerPaths) {
  test(`${compilerPath}: transformed faceted bars render through the same drawing backend`, async () => {
    const compiler = await import(compilerPath);
    const spec = {
      data: {values: [
        {panel: 'North', group: 'A', value: 1}, {panel: 'North', group: 'A', value: 2},
        {panel: 'North', group: 'B', value: 2}, {panel: 'South', group: 'A', value: 4},
        {panel: 'South', group: 'B', value: 1},
      ]},
      transform: [{calculate: 'datum.value * 2', as: 'twice'}],
      facet: {column: {field: 'panel', type: 'nominal'}},
      spec: {
        width: 90, height: 100, mark: 'bar',
        encoding: {
          x: {field: 'group', type: 'nominal'},
          y: {aggregate: 'sum', field: 'twice', type: 'quantitative'},
        },
      },
    };
    const result = await renderSpec(compiler.compile(spec).spec);
    const bars = items(result, 'rect');
    assert.equal(bars.length, 4);
    assert.deepEqual(bars.map(item => item.datum.sum_twice).sort((a, b) => a - b), [2, 4, 6, 8]);
    assert.equal(count(result.tikz, paint(bars[0].fill)), 4);
    assert.ok(result.tikz.includes('North') && result.tikz.includes('South'));
  });
}
