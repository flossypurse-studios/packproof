import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entrySpecifiers, classifyLoadFailure, firstLines } from '../src/checks.js';

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
