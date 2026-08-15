import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffFileLists,
  manifestEntryPaths,
  isDeclaredPath,
  checkFileDiff,
  diffSpec,
} from '../src/diff.js';

// The contract these defend: a path the LAST release resolved imports to that is
// gone fails the run; any other file that stopped shipping is named but does not
// fail, because deleting an internal file is normal and packproof does not guess
// intent. Everything here is pure — paths and manifests in, findings out.

test('diffFileLists is order-independent and reports both directions', () => {
  const d = diffFileLists(['b.js', 'a.js', 'gone.js'], ['a.js', 'new.js', 'b.js']);
  assert.deepEqual(d.added, ['new.js']);
  assert.deepEqual(d.removed, ['gone.js']);
  assert.deepEqual(d.kept, ['a.js', 'b.js']);
  assert.equal(d.previousCount, 3);
  assert.equal(d.currentCount, 3);
  assert.equal(d.identical, false);
});

test('diffFileLists normalises ./ and duplicate paths', () => {
  const d = diffFileLists(['./a.js', 'a.js', '/b.js'], ['a.js', 'b.js']);
  assert.equal(d.identical, true);
  assert.equal(d.previousCount, 2);
});

test('manifestEntryPaths collects every field an import can land on', () => {
  const { literals } = manifestEntryPaths({
    main: './dist/index.cjs',
    module: 'dist/index.mjs',
    types: './dist/index.d.ts',
    exports: {
      '.': { import: './dist/index.mjs', require: './dist/index.cjs' },
      './helper': './dist/helper.mjs',
      './package.json': './package.json',
    },
    bin: { tool: './bin/tool.js' },
  });
  for (const p of ['dist/index.cjs', 'dist/index.mjs', 'dist/index.d.ts', 'dist/helper.mjs', 'bin/tool.js', 'package.json']) {
    assert.ok(literals.has(p), `expected ${p}`);
  }
});

test('an exports wildcard matches the paths it stands for, and nothing else', () => {
  const entries = manifestEntryPaths({ exports: { './locales/*': './locales/*.json' } });
  assert.equal(isDeclaredPath('locales/fr.json', entries), true);
  assert.equal(isDeclaredPath('./locales/fr.json', entries), true);
  assert.equal(isDeclaredPath('locales/fr.js', entries), false);
  assert.equal(isDeclaredPath('src/locales/fr.json', entries), false);
});

test('an extensionless main counts the files node would actually try', () => {
  const entries = manifestEntryPaths({ main: 'lib/entry' });
  assert.equal(isDeclaredPath('lib/entry.js', entries), true);
  assert.equal(isDeclaredPath('lib/entry/index.js', entries), true);
  assert.equal(isDeclaredPath('lib/entryish.js', entries), false);
});

test('imports/# aliases and URLs are not treated as shipped files', () => {
  const { literals } = manifestEntryPaths({ exports: { './x': '#internal' }, browser: 'https://cdn/x.js' });
  assert.equal(literals.size, 0);
});

test('a dropped declared path fails the check', () => {
  const chk = checkFileDiff({
    previousVersion: 'pkg@1.2.0',
    previousFiles: ['package.json', 'dist/index.js', 'dist/helper.js'],
    previousManifest: { main: 'dist/index.js', exports: { './helper': './dist/helper.js' } },
    files: ['package.json', 'dist/index.js'],
  });
  assert.equal(chk.pass, false);
  assert.equal(chk.kind, 'dropped-entry-point');
  assert.deepEqual(chk.paths, ['dist/helper.js']);
  assert.match(chk.detail, /3 files → 2/);
  assert.match(chk.detail, /dist\/helper\.js/);
  assert.match(chk.hint, /"files" in package\.json/);
});

test('an internal file that stopped shipping is named, not failed', () => {
  const chk = checkFileDiff({
    previousVersion: 'pkg@1.2.0',
    previousFiles: ['package.json', 'index.js', 'templates/base.html'],
    previousManifest: { main: 'index.js' },
    files: ['package.json', 'index.js'],
  });
  assert.equal(chk.pass, true);
  assert.match(chk.note, /-1 gone: templates\/base\.html/);
  assert.deepEqual(chk.removed, ['templates/base.html']);
});

test('additions alone are a note with no removals', () => {
  const chk = checkFileDiff({
    previousVersion: 'pkg@1.2.0',
    previousFiles: ['package.json', 'index.js'],
    previousManifest: { main: 'index.js' },
    files: ['package.json', 'index.js', 'extra.js'],
  });
  assert.equal(chk.pass, true);
  assert.match(chk.note, /\+1 new: extra\.js/);
  assert.doesNotMatch(chk.note, /gone/);
});

test('an identical file list says so, and says when it is the same version', () => {
  const same = { previousFiles: ['package.json', 'index.js'], files: ['index.js', 'package.json'] };
  const plain = checkFileDiff({ previousVersion: 'pkg@1.2.0', ...same });
  assert.equal(plain.pass, true);
  assert.match(plain.note, /identical file list, 2 files$/);
  const self = checkFileDiff({ previousVersion: 'pkg@1.2.0', ...same, sameVersion: true });
  assert.match(self.note, /same version/);
});

test('types that stop shipping entirely fail, even with no declared path gone', () => {
  const chk = checkFileDiff({
    previousVersion: 'pkg@1.2.0',
    previousFiles: ['package.json', 'index.js', 'index.d.ts'],
    previousManifest: { main: 'index.js' },
    files: ['package.json', 'index.js'],
  });
  assert.equal(chk.pass, false);
  assert.equal(chk.kind, 'dropped-types');
  assert.match(chk.detail, /shipped 1 type declaration and this tarball ships none/);
});

test('types that merely move are not a dropped-types failure', () => {
  const chk = checkFileDiff({
    previousVersion: 'pkg@1.2.0',
    previousFiles: ['package.json', 'index.js', 'index.d.ts'],
    previousManifest: { main: 'index.js' },
    files: ['package.json', 'index.js', 'dist/index.d.ts'],
  });
  assert.equal(chk.pass, true);
  assert.match(chk.note, /gone: index\.d\.ts/);
});

test('a long removal list is capped instead of printing everything', () => {
  const previousFiles = Array.from({ length: 30 }, (_, i) => `lib/f${i}.js`);
  const chk = checkFileDiff({
    previousVersion: 'pkg@1.2.0',
    previousFiles,
    previousManifest: {},
    files: [],
  });
  assert.equal(chk.pass, true); // nothing declared, so nothing resolves to a hole
  assert.match(chk.note, /and 22 more/);
  assert.equal(chk.removed.length, 30);
});

test('diffSpec turns a bare version into this package at that version', () => {
  assert.equal(diffSpec(true, 'pkg'), 'pkg@latest');
  assert.equal(diffSpec(undefined, 'pkg'), 'pkg@latest');
  assert.equal(diffSpec('0.6.0', 'pkg'), 'pkg@0.6.0');
  assert.equal(diffSpec('next', 'pkg'), 'pkg@next');
  assert.equal(diffSpec('other@1.0.0', 'pkg'), 'other@1.0.0');
  assert.equal(diffSpec('@scope/other@1.0.0', 'pkg'), '@scope/other@1.0.0');
  assert.equal(diffSpec('@scope/other', 'pkg'), '@scope/other@latest');
});

test('--strict fails on a file that stopped shipping but was never declared', () => {
  const args = {
    previousVersion: 'pkg@1.2.0',
    previousFiles: ['package.json', 'index.js', 'lib/extra.js'],
    previousManifest: { name: 'pkg', main: 'index.js' },
    files: ['package.json', 'index.js'],
  };
  const lenient = checkFileDiff(args);
  assert.equal(lenient.pass, true);
  assert.match(lenient.note, /-1 gone: lib\/extra\.js/);

  const strict = checkFileDiff({ ...args, strict: true });
  assert.equal(strict.pass, false);
  assert.equal(strict.kind, 'dropped-file');
  assert.deepEqual(strict.paths, ['lib/extra.js']);
  assert.deepEqual(strict.removed, ['lib/extra.js']);
  assert.match(strict.hint, /--strict/);
  assert.match(strict.detail, /3 files → 2/);
});

test('--strict does not touch added-only or identical file lists', () => {
  const added = {
    previousVersion: 'pkg@1.2.0',
    previousFiles: ['package.json', 'index.js'],
    previousManifest: { name: 'pkg', main: 'index.js' },
    files: ['package.json', 'index.js', 'lib/new.js'],
  };
  assert.deepEqual(checkFileDiff({ ...added, strict: true }), checkFileDiff(added));
  assert.equal(checkFileDiff({ ...added, strict: true }).pass, true);

  const same = { ...added, files: ['package.json', 'index.js'] };
  assert.deepEqual(checkFileDiff({ ...same, strict: true }), checkFileDiff(same));
  assert.equal(checkFileDiff({ ...same, strict: true }).pass, true);
});

test('--strict still reports a dropped entry point as dropped-entry-point', () => {
  const chk = checkFileDiff({
    previousVersion: 'pkg@1.2.0',
    previousFiles: ['package.json', 'index.js', 'lib/extra.js'],
    previousManifest: { name: 'pkg', main: 'index.js' },
    files: ['package.json'],
    strict: true,
  });
  assert.equal(chk.pass, false);
  assert.equal(chk.kind, 'dropped-entry-point');
});
