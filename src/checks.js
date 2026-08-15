import { runInRoom, runBin } from './cleanroom.js';

/** Collect the entry specifiers a consumer could import, from main/module/exports. */
export function entrySpecifiers(manifest) {
  const name = manifest.name;
  const specs = new Set();
  const exp = manifest.exports;
  if (exp === undefined) {
    if (manifest.main || manifest.module) specs.add(name);
  } else if (typeof exp === 'string') {
    specs.add(name);
  } else if (exp && typeof exp === 'object') {
    let sawSubpath = false;
    for (const key of Object.keys(exp)) {
      if (!key.startsWith('.')) continue; // conditions-only export map
      sawSubpath = true;
      if (key.includes('*')) continue; // can't probe wildcards without globbing the tarball
      specs.add(key === '.' ? name : `${name}/${key.slice(2)}`);
    }
    if (!sawSubpath) specs.add(name);
  }
  return [...specs];
}

// Node echoes the offending source line before the message, and that echo often
// contains the error *code*. So look for the human-readable messages first, in
// priority order, and only fall back to the bare code.
const PATTERNS = [
  /Cannot find package '([^']+)' imported from/,
  /Cannot find module '([^']+)' imported from/,
  /Cannot find package '([^']+)'/,
  /Cannot find module '([^']+)'/,
  /Cannot find package "([^"]+)"/,
];

function missingSpecifier(stderr) {
  for (const re of PATTERNS) {
    const m = stderr.match(re);
    if (m) return m[1];
  }
  if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(stderr)) return '';
  return null;
}

/** Trim a clean-room absolute path down to the part the author will recognise. */
function shortenPath(p) {
  const i = p.indexOf('node_modules/');
  if (i === -1) return p;
  const rest = p.slice(i + 'node_modules/'.length);
  const parts = rest.split('/');
  return parts.slice(parts[0].startsWith('@') ? 2 : 1).join('/') || rest;
}

/**
 * Turn a clean-room failure into something the author can act on.
 * The kind is the product: "it broke" is useless, "your devDependency leaked" is not.
 */
export function classifyLoadFailure(stderr, manifest = {}) {
  const missing = missingSpecifier(stderr || '');
  if (missing !== null) {
    const bare =
      missing && !missing.startsWith('.') && !missing.startsWith('/') && !missing.startsWith('file:');
    if (bare) {
      const declared = {
        ...(manifest.dependencies || {}),
        ...(manifest.peerDependencies || {}),
        ...(manifest.optionalDependencies || {}),
      };
      const root = missing.startsWith('@')
        ? missing.split('/').slice(0, 2).join('/')
        : missing.split('/')[0];
      if (!declared[root]) {
        const dev = (manifest.devDependencies || {})[root];
        return {
          kind: 'undeclared-dependency',
          missing: root,
          hint: dev
            ? `"${root}" is required at runtime but is only in devDependencies, where it works for you and for nobody else. Move it to dependencies.`
            : `"${root}" is required at runtime but is not in dependencies. Add it, or stop importing it.`,
        };
      }
      return {
        kind: 'missing-dependency',
        missing: root,
        hint: `"${root}" is declared as a dependency but could not be resolved after install.`,
      };
    }
    return {
      kind: 'missing-file',
      missing: missing || null,
      hint: missing
        ? `"${shortenPath(missing)}" did not ship in the tarball. Check the "files" field and .npmignore.`
        : 'a file the package imports did not ship in the tarball. Check the "files" field and .npmignore.',
    };
  }
  if (/ENOENT/.test(stderr || '')) {
    return {
      kind: 'missing-file',
      missing: null,
      hint: 'the package read a file at runtime that did not ship in the tarball. Check the "files" field and .npmignore.',
    };
  }
  return { kind: 'load-error', missing: null, hint: 'the module threw while loading.' };
}

/** Probe every entry specifier with a real dynamic import from the clean room. */
export function checkEntries(room, manifest) {
  const results = [];
  for (const spec of entrySpecifiers(manifest)) {
    const r = runInRoom(room, `await import(${JSON.stringify(spec)});\nconsole.log('ok');\n`);
    if (r.ok) {
      results.push({ name: `import "${spec}"`, pass: true });
    } else {
      const c = classifyLoadFailure(r.stderr, manifest);
      results.push({
        name: `import "${spec}"`,
        pass: false,
        kind: c.kind,
        missing: c.missing,
        hint: c.hint,
        detail: firstLines(r.stderr),
      });
    }
  }
  return results;
}

/** Probe require() too — CJS consumers are still most of the ecosystem. */
export function checkRequire(room, manifest) {
  if (manifest.type === 'module') return []; // ESM-only package: require would fail by design
  const results = [];
  for (const spec of entrySpecifiers(manifest)) {
    const r = runInRoom(
      room,
      `const { createRequire } = await import('node:module');\nconst require = createRequire(${JSON.stringify(
        room.dir + '/x.js'
      )});\nrequire(${JSON.stringify(spec)});\nconsole.log('ok');\n`
    );
    if (r.ok) results.push({ name: `require("${spec}")`, pass: true });
    else {
      const c = classifyLoadFailure(r.stderr, manifest);
      results.push({
        name: `require("${spec}")`,
        pass: false,
        kind: c.kind,
        missing: c.missing,
        hint: c.hint,
        detail: firstLines(r.stderr),
      });
    }
  }
  return results;
}

const NOT_EXECUTABLE = /Syntax error|exec format error|ENOEXEC|cannot execute|command not found|: not found/i;

/** Actually execute each declared bin. A bin that cannot start is a broken package. */
export function checkBins(room, manifest, { binArgs = ['--version'], strict = false } = {}) {
  const bin = manifest.bin;
  if (!bin) return [];
  const names =
    typeof bin === 'string' ? { [manifest.name.replace(/^@[^/]+\//, '')]: bin } : bin;
  const results = [];
  for (const name of Object.keys(names)) {
    const r = runBin(room, name, binArgs);
    const combined = `${r.error || ''}\n${r.stderr}\n${r.stdout}`;
    if (r.error && /ENOENT/.test(r.error)) {
      results.push({
        name: `bin "${name}"`,
        pass: false,
        kind: 'bin-missing',
        hint: `node_modules/.bin/${name} was not created. The file "${names[name]}" probably did not ship in the tarball.`,
        detail: r.error,
      });
      continue;
    }
    if (NOT_EXECUTABLE.test(combined)) {
      results.push({
        name: `bin "${name}"`,
        pass: false,
        kind: 'bin-not-executable',
        hint: `the shell could not execute ${name}. A missing "#!/usr/bin/env node" shebang is the usual cause.`,
        detail: firstLines(combined),
      });
      continue;
    }
    if (/Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/.test(combined)) {
      const c = classifyLoadFailure(combined, manifest);
      results.push({
        name: `bin "${name}"`,
        pass: false,
        kind: c.kind,
        missing: c.missing,
        hint: c.hint,
        detail: firstLines(combined),
      });
      continue;
    }
    // A nonzero exit is not automatically a packaging bug: --version may be unsupported.
    // Under --strict you have said you want to hear about it anyway.
    if (strict && !r.ok) {
      results.push({
        name: `bin "${name}"`,
        pass: false,
        kind: 'bin-nonzero-exit',
        hint:
          `${name} ran and exited ${r.status} with ${binArgs.join(' ')}. It loaded, so this is not necessarily a ` +
          `packaging problem — --version may simply be unsupported — but it is a failure because you asked for --strict. ` +
          `Use --bin-args to give it something it does support.`,
        detail: firstLines(combined) || `exited ${r.status}`,
      });
      continue;
    }
    results.push({
      name: `bin "${name}"`,
      pass: true,
      note: r.ok ? undefined : `exited ${r.status} (not necessarily a packaging problem)`,
    });
  }
  return results;
}

export function firstLines(s, n = 2) {
  const lines = (s || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // Prefer the lines that actually say what went wrong over node's loader internals.
  const meaningful = lines.filter(
    (l) =>
      /^[A-Za-z]*Error(\s*\[[A-Z_]+\])?:/.test(l) ||
      /Cannot find (module|package)|Syntax error|exec format|ENOEXEC|ENOENT|command not found/.test(l)
  );
  return (meaningful.length ? meaningful : lines).slice(0, n).join('\n');
}
