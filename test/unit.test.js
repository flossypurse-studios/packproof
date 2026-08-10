import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entrySpecifiers, classifyLoadFailure, firstLines } from '../src/checks.js';
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
