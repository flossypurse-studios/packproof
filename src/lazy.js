import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinModules } from 'node:module';

// Execution proves what the code *does*. It cannot prove what the code would do
// on a branch nobody took. A dependency that is only required inside a function
// body — a lazy require for an optional feature, an error path, a subcommand —
// is invisible to every check that works by running the package. So for those,
// and only those, we read the shipped source.
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const SOURCE_EXT = /\.(js|mjs|cjs)$/;

/** Patterns that name a module the shipped code will try to load. */
const PATTERNS = [
  { re: /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, verb: 'require' },
  { re: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, verb: 'import()' },
  { re: /\bimport\s+(?:[^'";()]+?\s+from\s+)?['"]([^'"]+)['"]/g, verb: 'import' },
  { re: /\bexport\s+(?:[^'";()]+?\s+from\s+)?['"]([^'"]+)['"]/g, verb: 'export from' },
];

/**
 * The package a bare specifier resolves to, or null for a relative/absolute path.
 * "lodash/fp" → "lodash";  "@scope/pkg/sub" → "@scope/pkg";  "./x" → null.
 */
const PKG_NAME = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/;

export function packageNameOf(spec) {
  if (!spec) return null;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:')) return null;
  if (spec.startsWith('node:')) return spec;
  const parts = spec.split('/');
  const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return PKG_NAME.test(name) ? name : null; // not a specifier we can be sure about
}

/**
 * Reduce a source file to the parts that are really code: comment bodies and
 * template-literal text are blanked out (offsets and newlines preserved, so
 * line numbers stay honest), while `${...}` interpolations — which are code —
 * are kept. Without this, any package that generates JS in a template string
 * gets reported for importing "${spec}", and a precision problem in a tool that
 * exists to tell you the truth is worse than no tool.
 */
export function codeOnly(src) {
  let out = '';
  let i = 0;
  let prev = ''; // last significant code char: tells division from a regex literal
  let mode = 'code';
  const stack = []; // modes we return to
  const depths = []; // brace depth inside each open ${...}

  const blank = (c) => (c === '\n' ? '\n' : ' ');

  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];

    if (mode === 'template') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '`') { out += ' '; mode = stack.pop(); i++; continue; }
      if (c === '$' && d === '{') { out += '  '; stack.push('template'); depths.push(0); mode = 'interp'; i += 2; continue; }
      out += blank(c);
      i++;
      continue;
    }

    // mode is 'code' or 'interp'
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += blank(src[i]); i++; }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === c || src[i] === '\n') { i++; break; }
        i++;
      }
      prev = c;
      continue;
    }
    if (c === '`') { out += ' '; stack.push(mode); mode = 'template'; i++; continue; }
    if (c === '/' && isRegexStart(prev)) {
      out += c;
      i++;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === '/') { i++; break; }
        i++;
      }
      prev = '/';
      continue;
    }
    if (mode === 'interp') {
      if (c === '{') depths[depths.length - 1]++;
      else if (c === '}') {
        if (depths[depths.length - 1] === 0) { depths.pop(); out += ' '; mode = stack.pop(); i++; continue; }
        depths[depths.length - 1]--;
      }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

function isRegexStart(prev) {
  return prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev);
}

/** Every bare specifier the shipped source mentions, with where it was found. */
export function scanSource(source) {
  const code = codeOnly(source);
  const found = [];
  const seen = new Set();
  for (const { re, verb } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const pkg = packageNameOf(m[1]);
      if (!pkg) continue;
      const line = code.slice(0, m.index).split('\n').length;
      const key = `${pkg}@${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ pkg, specifier: m[1], line, verb });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** Where the installed copy of the package lives inside the clean room. */
function installedDir(room, name) {
  return join(room.dir, 'node_modules', ...name.split('/'));
}

/**
 * Deep probe: read every JS file that actually shipped and check that every
 * package it imports is declared as a runtime dependency. This is the one check
 * here that is static rather than executed, and it exists because the branches
 * an import hides behind are exactly where undeclared dependencies survive.
 */
export function checkLazyImports(room, manifest, files, { already = new Set() } = {}) {
  const declared = new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.peerDependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
  ]);
  const dev = new Set(Object.keys(manifest.devDependencies || {}));
  const base = installedDir(room, manifest.name);
  const results = [];
  const reported = new Set();
  let scanned = 0;

  for (const file of files.filter((f) => SOURCE_EXT.test(f))) {
    let source;
    try {
      source = readFileSync(join(base, ...file.split('/')), 'utf8');
    } catch {
      continue; // not where we expected it; the execution checks own that failure
    }
    scanned++;
    for (const hit of scanSource(source)) {
      if (BUILTINS.has(hit.pkg)) continue;
      if (hit.pkg.startsWith('node:')) continue; // unknown node: builtin — still not a dependency
      if (hit.pkg === manifest.name) continue; // self-reference, resolvable via exports
      if (declared.has(hit.pkg)) continue;
      if (already.has(hit.pkg)) continue; // the execution checks already reported this one
      const where = `${file}:${hit.line}`;
      const key = `${where} ${hit.pkg}`;
      if (reported.has(key)) continue;
      reported.add(key);
      results.push({
        name: `${hit.verb}("${hit.specifier}") in ${where}`,
        pass: false,
        kind: 'undeclared-dependency',
        missing: hit.pkg,
        // Machine-readable location, for --format=github/junit: the human name
        // above already says file:line, but a formatter should not have to parse it.
        file,
        line: hit.line,
        hint: dev.has(hit.pkg)
          ? `"${hit.pkg}" is loaded at runtime from ${where} but is only in devDependencies, where it works for you and for nobody else. Move it to dependencies.`
          : `"${hit.pkg}" is loaded at runtime from ${where} but is not declared as a dependency at all. Add it, or stop importing it.`,
        detail: `found by --lazy: this line is not reached when the package is merely imported, so running it proves nothing about ${hit.pkg}.`,
      });
    }
  }

  if (!results.length) {
    results.push({
      name: `--lazy deep probe`,
      pass: true,
      note: `${scanned} shipped source file${scanned === 1 ? '' : 's'} scanned, every import declared`,
    });
  }
  return results;
}
