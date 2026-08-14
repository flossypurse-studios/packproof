// End-to-end tests: each fixture is packed, installed into a real clean room,
// and probed. These are the tests that matter — they prove the whole pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { packproof } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => join(here, 'fixtures', n);
const TIMEOUT = 180000;

function kinds(result) {
  return result.failures.map((f) => f.kind);
}

test('a devDependency required at runtime is caught as undeclared-dependency', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('broken-devdep'));
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ['undeclared-dependency']);
  assert.match(r.failures[0].hint, /pp-fixture-ghost/);
  // npm pack and npm install both report this package as perfectly fine:
  assert.equal(r.checks.find((c) => c.name === 'npm install <tarball>').pass, true);
});

test('a runtime file excluded from "files" is caught as missing-file', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('broken-missing-asset'));
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ['missing-file']);
  assert.match(r.failures[0].hint, /internal\/table\.js/);
  assert.ok(!r.files.includes('internal/table.js'), 'the asset really is absent from the tarball');
});

test('a bin without a shebang is caught as bin-not-executable', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('broken-bin-no-shebang'));
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ['bin-not-executable']);
  assert.match(r.failures[0].hint, /shebang/);
  // The entry point itself is fine; only the bin is broken.
  assert.equal(r.checks.find((c) => c.name.startsWith('import')).pass, true);
});

test('a correct ESM package with subpath exports and a bin passes', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('good-esm'));
  assert.deepEqual(kinds(r), []);
  assert.equal(r.ok, true);
  const names = r.checks.map((c) => c.name);
  assert.ok(names.includes('import "pp-fixture-good-esm"'));
  assert.ok(names.includes('import "pp-fixture-good-esm/util"'), 'subpath export was probed');
  assert.ok(names.includes('bin "pp-fixture-good"'), 'bin was executed');
  // type:module means require() is not probed, by design.
  assert.ok(!names.some((n) => n.startsWith('require(')));
});

test('a correct CJS package passes and is probed with both import and require', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('good-cjs'));
  assert.equal(r.ok, true);
  const names = r.checks.map((c) => c.name);
  assert.ok(names.includes('import "pp-fixture-good-cjs"'));
  assert.ok(names.includes('require("pp-fixture-good-cjs")'));
  // every run reports what shipped, from the tarball's own file list
  const shipped = r.checks.find((c) => c.name === 'shipped files');
  assert.equal(shipped.pass, true);
  assert.match(shipped.note, new RegExp(`^${r.fileCount} files?, no credentials or cruft// End-to-end tests: each fixture is packed, installed into a real clean room,
// and probed. These are the tests that matter — they prove the whole pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { packproof } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => join(here, 'fixtures', n);
const TIMEOUT = 180000;

function kinds(result) {
  return result.failures.map((f) => f.kind);
}

test('a devDependency required at runtime is caught as undeclared-dependency', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('broken-devdep'));
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ['undeclared-dependency']);
  assert.match(r.failures[0].hint, /pp-fixture-ghost/);
  // npm pack and npm install both report this package as perfectly fine:
  assert.equal(r.checks.find((c) => c.name === 'npm install <tarball>').pass, true);
});

test('a runtime file excluded from "files" is caught as missing-file', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('broken-missing-asset'));
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ['missing-file']);
  assert.match(r.failures[0].hint, /internal\/table\.js/);
  assert.ok(!r.files.includes('internal/table.js'), 'the asset really is absent from the tarball');
});

test('a bin without a shebang is caught as bin-not-executable', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('broken-bin-no-shebang'));
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ['bin-not-executable']);
  assert.match(r.failures[0].hint, /shebang/);
  // The entry point itself is fine; only the bin is broken.
  assert.equal(r.checks.find((c) => c.name.startsWith('import')).pass, true);
});

test('a correct ESM package with subpath exports and a bin passes', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('good-esm'));
  assert.deepEqual(kinds(r), []);
  assert.equal(r.ok, true);
  const names = r.checks.map((c) => c.name);
  assert.ok(names.includes('import "pp-fixture-good-esm"'));
  assert.ok(names.includes('import "pp-fixture-good-esm/util"'), 'subpath export was probed');
  assert.ok(names.includes('bin "pp-fixture-good"'), 'bin was executed');
  // type:module means require() is not probed, by design.
  assert.ok(!names.some((n) => n.startsWith('require(')));
});

test('a correct CJS package passes and is probed with both import and require', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('good-cjs'));
  assert.equal(r.ok, true);
));
});

test('--skip-require suppresses the require probe', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('good-cjs'), { skipRequire: true });
  assert.equal(r.ok, true);
  assert.ok(!r.checks.some((c) => c.name.startsWith('require(')));
});

test('the result shape is stable enough to consume from --json', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('good-cjs'));
  assert.equal(r.name, 'pp-fixture-good-cjs');
  assert.equal(r.version, '1.0.0');
  assert.equal(typeof r.fileCount, 'number');
  assert.ok(r.files.includes('package.json'));
  assert.ok(r.tarball.endsWith('.tgz'));
  assert.equal(r.packed, true);
  assert.equal(r.room, null, 'clean room is cleaned up unless --keep');
  assert.equal(typeof r.durationMs, 'number');
  assert.ok(JSON.stringify(r).length > 0);
});

test('packproof proves itself: this package installs and runs clean', { timeout: TIMEOUT }, async () => {
  const r = await packproof(join(here, '..'));
  assert.equal(r.ok, true, JSON.stringify(r.failures, null, 2));
  assert.equal(r.name, 'packproof');
});

test('a missing package.json fails loudly rather than silently passing', async () => {
  await assert.rejects(() => packproof(join(here, 'fixtures')), /no package\.json found/);
});

test('multiple independent defects are all reported', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('broken-everything'));
  assert.equal(r.ok, false);
  // The entry point and the bin are separate probes, so both are reported.
  assert.deepEqual(kinds(r).sort(), ['bin-not-executable', 'undeclared-dependency']);
});

// The money test for --lazy: the same fixture, with and without the flag. If the
// "without" half ever starts failing, --lazy is redundant and should be deleted.
test('a devDependency required only inside a function is invisible without --lazy', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('broken-lazy-devdep'));
  assert.equal(r.ok, true, 'executing the package proves nothing about a branch nobody took');
  assert.deepEqual(kinds(r), []);
});

test('--lazy catches a devDependency required only inside a function, with file and line', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('broken-lazy-devdep'), { lazy: true });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ['undeclared-dependency']);
  const f = r.failures[0];
  assert.match(f.hint, /pp-fixture-ghost2/);
  assert.match(f.hint, /devDependencies/);
  assert.match(f.hint, /index\.js:\d+/, 'the hint says exactly where to look');
  assert.match(f.name, /index\.js:10/);
  assert.equal(f.missing, 'pp-fixture-ghost2');
  // a commented-out require and a node: builtin in the same file are not reported
  assert.equal(r.failures.length, 1);
  // and the package still installs and imports cleanly — that is the whole point
  assert.equal(r.checks.find((c) => c.name === 'npm install <tarball>').pass, true);
});

test('--lazy reports a clean pass on a package whose imports are all declared', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('good-esm'), { lazy: true });
  assert.equal(r.ok, true);
  const probe = r.checks.find((c) => c.name === '--lazy deep probe');
  assert.ok(probe && probe.pass, 'the deep probe reports itself when it finds nothing');
  assert.match(probe.note, /scanned/);
});

test('--lazy does not report the same package twice when loading already failed on it', { timeout: TIMEOUT }, async () => {
  const r = await packproof(fixture('broken-devdep'), { lazy: true });
  assert.deepEqual(kinds(r), ['undeclared-dependency'], 'one problem, reported once');
  assert.match(r.failures[0].name, /^import /);
});
