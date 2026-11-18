// Run from vl-convert-rs:
// node --loader ./tests/vendor-loader.mjs ./tests/tikz/generate.mjs OUTPUT_DIR [--compile]
// Generates the exact specs, SVG references, TikZ source, and TeX wrappers.
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixtures, loadFixture, renderFixture} from './helpers.mjs';

const args = process.argv.slice(2);
const compile = args.includes('--compile');
const directories = args.filter(arg => arg !== '--compile');
if (directories.length > 1) throw new Error('Expected OUTPUT_DIR and optional --compile');
const directory = resolve(directories[0] || 'tests/output/tikz');
await mkdir(directory, {recursive: true});
const evidence = [];
for (const fixture of fixtures) {
  const result = await renderFixture(fixture.name, {svg: true});
  const original = await loadFixture(fixture.name);
  const filename = `${fixture.name}.${fixture.kind}.json`;
  await writeFile(resolve(directory, filename), JSON.stringify(original.spec, null, 2) + '\n');
  await writeFile(resolve(directory, `${fixture.name}.svg`), result.svg);
  await writeFile(resolve(directory, `${fixture.name}.tikz`), result.tikz);
  const tex = String.raw`\RequirePackage{fix-cm}
\documentclass[tikz,border=0pt]{standalone}
\begin{document}
\input{${fixture.name}.tikz}
\end{document}
`;
  await writeFile(resolve(directory, `${fixture.name}.tex`), tex);
  if (compile) {
    const latex = spawnSync('pdflatex', [
      '-no-shell-escape', '-output-format=pdf', '-interaction=nonstopmode',
      '-halt-on-error', `${fixture.name}.tex`,
    ], {cwd: directory, encoding: 'utf8', timeout: 60000});
    await writeFile(resolve(directory, `${fixture.name}.compile.log`),
      `${latex.stdout || ''}\n${latex.stderr || ''}`);
    if (latex.error) throw latex.error;
    if (latex.status !== 0) throw new Error(`TeX compilation failed: ${fixture.name}.compile.log`);
    const pdf = await readFile(resolve(directory, `${fixture.name}.pdf`));
    if (pdf.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error(`TeX did not produce a PDF: ${fixture.name}.pdf`);
    }
  }
  evidence.push({
    name: fixture.name, input: filename, textMode: fixture.textMode || 'plain',
    width: result.width, height: result.height, origin: result.origin,
    pdfWidthBp: result.width * 0.75, pdfHeightBp: result.height * 0.75,
    compiled: compile,
  });
  console.log(`${fixture.name}: ${result.width} × ${result.height}px${compile ? ', TeX compiled' : ''}`);
}
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(evidence, null, 2) + '\n');
