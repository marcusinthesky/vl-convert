// Test-only Node loader for the exact JavaScript shipped by vl-convert.
// Network imports are resolved to the generated vendored import map, offline.
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

const crate = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(path.join(crate, 'src/module_loader/import_map.rs'), 'utf8');
const modules = new Map();
for (const match of source.matchAll(/\(\s*"([^"\n]+)"\.to_string\(\),\s*include_str!\(\s*"([^"]+)"\s*\)/g)) {
  modules.set(match[1], pathToFileURL(path.resolve(crate, 'src/module_loader', match[2])).href);
}

export async function resolve(specifier, context, nextResolve) {
  const key = specifier.startsWith('https://cdn.jsdelivr.net')
    ? new URL(specifier).pathname : specifier;
  if (key.startsWith('/npm/')) {
    const url = modules.get(key);
    if (!url) throw new Error(`Module is not vendored: ${specifier}`);
    return {url, shortCircuit: true};
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.js')) {
    return {format: 'module', source: await readFile(new URL(url), 'utf8'), shortCircuit: true};
  }
  return nextLoad(url, context);
}
