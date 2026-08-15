import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { entrySpecifiers, classifyLoadFailure, firstLines, checkBins } from '../src/checks.js';
import { packageNameOf, codeOnly, scanSource } from '../src/lazy.js';

test('entrySpecifiers: main only', () => {
  assert.deepEqual(entrySpecifiers({ name: 'a', main: 'index.js' }), ['a']);
});

test('entrySpecifiers: module only', () => {
  assert.deepEqual(entrySpecifiers({ name: 'a', module: 'index.mjs' }), ['a']);
});

test('entrySpecifiers: no entry at all', () => {
  assert.deepEqual(entrySpecifiers({ name: 'a' }), []);
});

test('entrySpecifiers: string exports', () => {
  assert.deepEqual(entrySpecifiers({ name: 'a', exports: './i.js' }), ['a']);
});

test('entrySpecifiers: subpath exports', () => {
  assert.deepEqual(
    entrySpecifiers({ name: 'a', exports: { '.': './i.js', './util': './u.js' } }),
    ['a', 'a/util']
  );
});

test('entrySpecifiers: conditions-only export map still probes the root', () => {
  assert.deepEqual(
    entrySpecifiers({ name: 'a', exports: { import: './i.mjs', require: './i.cjs' } }),
    ['a']
  );
});

test('entrySpecifiers: wildcard subpaths are skipped, not guessed', () => {
  assert.deepEqual(entrySpecifiers({ name: 'a', exports: { '.': './i.js', './*': './lib/*.js' } }), [
    'a',
  ]);
});

test('classify: devDependency leak is undeclared-dependency', () => {
  const stderr = `node:internal/modules/package_json_reader:314
    throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'chalk' imported from /tmp/room/node_modules/a/index.js`;
  const c = classifyLoadFailure(stderr, { name: 'a', devDependencies: { chalk: '^5' } });
  assert.equal(c.kind, 'undeclared-dependency');
  assert.equal(c.missing, 'chalk');
  assert.match(c.hint, /devDependencies/);
});

test('classify: undeclared and not even a devDependency', () => {
  const c = classifyLoadFailure("Cannot find package 'lodash' imported from /x/index.js", {
    name: 'a',
  });
  assert.equal(c.kind, 'undeclared-dependency');
  assert.match(c.hint, /not in dependencies/);
});

test('classify: scoped package root is the whole scope/name', () => {
  const c = classifyLoadFailure("Cannot find package '@scope/pkg/sub' imported from /x", {
    name: 'a',
    devDependencies: { '@scope/pkg': '^1' },
  });
  assert.equal(c.missing, '@scope/pkg');
  assert.equal(c.kind, 'undeclared-dependency');
});

test('classify: declared dependency that will not resolve is missing-dependency', () => {
  const c = classifyLoadFailure("Cannot find package 'dep' imported from /x", {
    name: 'a',
    dependencies: { dep: '^1' },
  });
  assert.equal(c.kind, 'missing-dependency');
});

test('classify: unshipped relative file is missing-file, path shortened', () => {
  const c = classifyLoadFailure(
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/room/node_modules/a/internal/table.js' imported from /tmp/room/node_modules/a/index.js",
    { name: 'a' }
  );
  assert.equal(c.kind, 'missing-file');
  assert.match(c.hint, /"internal\/table\.js"/);
});

test('classify: a runtime ENOENT is a missing file too', () => {
  const c = classifyLoadFailure("Error: ENOENT: no such file or directory, open '/x/data.json'", {});
  assert.equal(c.kind, 'missing-file');
});

test('classify: anything else is load-error', () => {
  const c = classifyLoadFailure('TypeError: x is not a function', {});
  assert.equal(c.kind, 'load-error');
});

test('firstLines prefers the real error over node internals', () => {
  const stderr = `node:internal/modules/esm/resolve:275
    throw new ERR_MODULE_NOT_FOUND(
          ^
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'chalk' imported from /x`;
  assert.match(firstLines(stderr), /^Error \[ERR_MODULE_NOT_FOUND\]/);
  assert.equal(firstLines(stderr).split('\n').length, 1);
});

// --- deep probe (--lazy) ---------------------------------------------------
test('packageNameOf resolves bare specifiers and rejects everything else', () => {
  assert.equal(packageNameOf('lodash'), 'lodash');
  assert.equal(packageNameOf('lodash/fp'), 'lodash');
  assert.equal(packageNameOf('@scope/pkg/sub/path.js'), '@scope/pkg');
  assert.equal(packageNameOf('node:fs'), 'node:fs');
  assert.equal(packageNameOf('./local.js'), null);
  assert.equal(packageNameOf('../up.js'), null);
  assert.equal(packageNameOf('/abs.js'), null);
  assert.equal(packageNameOf('file:///x.js'), null);
  // a template hole is not a package name — this is the false positive that
  // matters, because tools that generate JS in template strings are common.
  assert.equal(packageNameOf('${spec}'), null);
});

test('codeOnly blanks comments and template text but keeps interpolated code', () => {
  const src = [
    "// require('commented-out')",
    "/* require('block-commented') */",
    "const gen = `await import('generated-only')`;",
    "const mix = `${require('really-required')}`;",
    "const s = 'require(\"inside-a-string\")';",
  ].join('\n');
  const code = codeOnly(src);
  assert.ok(!code.includes('commented-out'));
  assert.ok(!code.includes('block-commented'));
  assert.ok(!code.includes('generated-only'), 'template literal text is not code');
  assert.ok(code.includes('really-required'), '${...} interpolations are code');
  // line count must be preserved so reported line numbers are trustworthy
  assert.equal(code.split('\n').length, src.split('\n').length);
});

test('scanSource finds every import form with the right line number', () => {
  const src = [
    "import a from 'alpha';",
    "import 'beta';",
    "export { x } from 'gamma';",
    "const d = require('delta');",
    "async function f() { await import('epsilon'); }",
    "import rel from './local.js';",
  ].join('\n');
  const hits = scanSource(src);
  assert.deepEqual(
    hits.map((h) => [h.pkg, h.line]),
    [['alpha', 1], ['beta', 2], ['gamma', 3], ['delta', 4], ['epsilon', 5]]
  );
});

test('scanSource does not report a regex literal as a comment boundary', () => {
  const hits = scanSource("const re = /https?:\\/\\//; const x = require('zeta');");
  assert.deepEqual(hits.map((h) => h.pkg), ['zeta']);
});

// checkBins needs only a directory with node_modules/.bin/<name> in it — no
// install — so the strict promotion can be tested against a real process exit.
function roomWithBin(script) {
  const dir = mkdtempSync(join(tmpdir(), 'packproof-bin-'));
  const binDir = join(dir, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, 'toolish');
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return { dir };
}

const MANIFEST = { name: 'toolish', bin: { toolish: 'cli.js' } };

test('a bin that exits nonzero is a note by default and a failure under --strict', () => {
  const room = roomWithBin('#!/usr/bin/env node\nconsole.error("unknown flag: --version");\nprocess.exit(3);\n');
  try {
    const [lenient] = checkBins(room, MANIFEST);
    assert.equal(lenient.pass, true);
    assert.equal(lenient.note, 'exited 3 (not necessarily a packaging problem)');

    const [strict] = checkBins(room, MANIFEST, { strict: true });
    assert.equal(strict.pass, false);
    assert.equal(strict.kind, 'bin-nonzero-exit');
    assert.equal(strict.name, 'bin "toolish"');
    assert.match(strict.hint, /--strict/);
    assert.match(strict.hint, /exited 3/);
  } finally {
    rmSync(room.dir, { recursive: true, force: true });
  }
});

test('a bin that exits zero passes identically with and without --strict', () => {
  const room = roomWithBin('#!/usr/bin/env node\nconsole.log("1.0.0");\n');
  try {
    assert.deepEqual(checkBins(room, MANIFEST, { strict: true }), checkBins(room, MANIFEST));
    assert.equal(checkBins(room, MANIFEST, { strict: true })[0].pass, true);
  } finally {
    rmSync(room.dir, { recursive: true, force: true });
  }
});
