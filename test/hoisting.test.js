// The hoisting check, tested where it can be tested honestly: the
// classification is pure, so it gets pinned here without an npm install
// anywhere in sight. The one thing that needs two real clean rooms — a package
// that imports its dependency's dependency — lives in fixtures.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  declaredNames,
  npmSupportsNested,
  npmVersion,
  hoistingSummaryCheck,
  nestedUnavailableCheck,
  hoistRoomFailureCheck,
  classifyHoistProbe,
  checkHoisting,
} from '../src/hoisting.js';
import { CHECK_IDS, CHECK_HELP, NEEDS_INSTALL, selectChecks } from '../src/select.js';
import { whyFor } from '../src/why.js';

const notFound = (pkg) =>
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '${pkg}' imported from /tmp/room/node_modules/thing/index.js`;

test('declaredNames covers every strength of dependency a manifest can claim', () => {
  const names = declaredNames({
    dependencies: { a: '^1' },
    peerDependencies: { b: '^2' },
    optionalDependencies: { c: '^3' },
    bundleDependencies: ['d'],
    bundledDependencies: ['e'],
    devDependencies: { f: '^6' },
  });
  assert.deepEqual([...names].sort(), ['a', 'b', 'c', 'd', 'e']);
  // devDependencies are deliberately absent: they are not shipped, so a
  // runtime import of one is undeclared, not merely un-hoisted.
  assert.equal(names.has('f'), false);
});

test('declaredNames is empty and harmless for a bare manifest', () => {
  assert.deepEqual([...declaredNames({})], []);
  assert.deepEqual([...declaredNames({ dependencies: null, bundleDependencies: 'nonsense' })], []);
});

test('npmSupportsNested wants npm 9 or newer, and never guesses', () => {
  assert.equal(npmSupportsNested('10.9.8'), true);
  assert.equal(npmSupportsNested('9.0.0'), true);
  assert.equal(npmSupportsNested('8.19.4'), false);
  assert.equal(npmSupportsNested('6.14.18'), false);
  assert.equal(npmSupportsNested(''), false);
  assert.equal(npmSupportsNested(null), false);
  assert.equal(npmSupportsNested('not-a-version'), false);
});

test('npmVersion reports the npm this machine actually has', () => {
  const v = npmVersion();
  // Either npm is here and says a version, or it is not and we admit null.
  assert.ok(v === null || /^\d+\.\d+/.test(v), `unexpected npm version: ${v}`);
});

test('the summary line says there is no hoisting surface when there are no dependencies', () => {
  const c = hoistingSummaryCheck(0);
  assert.equal(c.pass, true);
  assert.match(c.note, /no runtime dependencies/);
});

test('the summary line counts the dependencies whose own dependencies get flattened', () => {
  assert.match(hoistingSummaryCheck(1).note, /1 runtime dependency,/);
  assert.match(hoistingSummaryCheck(3).note, /3 runtime dependencies,/);
});

test('a passing probe is one clean line with no hint attached', () => {
  const c = classifyHoistProbe({ spec: 'pkg', ok: true });
  assert.deepEqual(c, { name: 'import "pkg" without hoisting', pass: true });
});

test('a package nobody declared is a phantom-dependency failure', () => {
  const c = classifyHoistProbe({ spec: 'pkg', ok: false, stderr: notFound('has-flag') }, declaredNames({
    dependencies: { 'supports-color': '^8' },
  }));
  assert.equal(c.pass, false);
  assert.equal(c.kind, 'phantom-dependency');
  assert.equal(c.missing, 'has-flag');
  assert.match(c.hint, /pnpm/);
  assert.match(c.hint, /Add "has-flag" to dependencies/);
});

test('a scoped phantom is attributed to the package, not the subpath', () => {
  const c = classifyHoistProbe(
    { spec: 'pkg', ok: false, stderr: notFound('@scope/thing/deep/mod.js') },
    declaredNames({ dependencies: { other: '^1' } })
  );
  assert.equal(c.missing, '@scope/thing');
});

test('a dependency this package DOES declare is a note, never a verdict', () => {
  const c = classifyHoistProbe(
    { spec: 'pkg', ok: false, stderr: notFound('supports-color') },
    declaredNames({ dependencies: { 'supports-color': '^8' } })
  );
  assert.equal(c.pass, true);
  assert.match(c.note, /a dependency this package does declare/);
  assert.match(c.note, /Not counted against you/);
});

test('a declared peer or optional dependency is not blamed either', () => {
  const declared = declaredNames({
    dependencies: { a: '^1' },
    peerDependencies: { react: '^18' },
    optionalDependencies: { fsevents: '^2' },
  });
  for (const name of ['react', 'fsevents']) {
    const c = classifyHoistProbe({ spec: 'pkg', ok: false, stderr: notFound(name) }, declared);
    assert.equal(c.pass, true, `${name} should not be counted against the package`);
  }
});

test('a package already blamed in the hoisted room is not said twice', () => {
  const c = classifyHoistProbe(
    { spec: 'pkg', ok: false, stderr: notFound('kleur') },
    declaredNames({ dependencies: { a: '^1' } }),
    new Set(['kleur'])
  );
  assert.equal(c, null);
});

test('a failure packproof cannot attribute to a package is a note, not a guess', () => {
  const c = classifyHoistProbe(
    { spec: 'pkg', ok: false, stderr: 'TypeError: x is not a function' },
    declaredNames({ dependencies: { a: '^1' } })
  );
  assert.equal(c.pass, true);
  assert.match(c.note, /could not attribute/);
  assert.match(c.note, /--keep/);
});

test('an unbuildable non-hoisted room passes and admits it proved nothing', () => {
  const c = hoistRoomFailureCheck('npm ERR! code EBADSTRATEGY\nsomething went wrong');
  assert.equal(c.pass, true);
  assert.equal(c.kind, 'hoisting-room-unavailable');
  assert.match(c.note, /Nothing is claimed about it/);
  assert.match(c.detail, /EBADSTRATEGY/);
});

test('an npm too old to nest passes and names the npm it found', () => {
  const c = nestedUnavailableCheck('8.19.4');
  assert.equal(c.pass, true);
  assert.equal(c.kind, 'hoisting-unavailable');
  assert.match(c.note, /npm 8\.19\.4/);
  assert.match(c.note, /Nothing is claimed about it/);
});

test('a package with no dependencies costs one line and no second install', () => {
  // No tarball, no room: if checkHoisting tried to install anything with this
  // manifest it would throw on the undefined tarball rather than return.
  const checks = checkHoisting(undefined, { name: 'x', version: '1.0.0', main: 'index.js' });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'dependency hoisting');
  assert.match(checks[0].note, /no runtime dependencies/);
});

test('a package with dependencies but no importable entry point installs nothing either', () => {
  const checks = checkHoisting(undefined, { name: 'x', version: '1.0.0', dependencies: { a: '^1' } });
  assert.equal(checks.length, 1);
  assert.match(checks[0].note, /1 runtime dependency/);
});

test('hoisting is a real check id: selectable, skippable, documented, install-dependent', () => {
  assert.ok(CHECK_IDS.includes('hoisting'));
  assert.ok(CHECK_HELP.hoisting);
  assert.ok(NEEDS_INSTALL.includes('hoisting'));
  assert.ok(whyFor('hoisting').ok);

  const skipped = selectChecks({ skip: ['hoisting'] });
  assert.equal(skipped.enabled.has('hoisting'), false);
  assert.deepEqual(skipped.skipped, [{ id: 'hoisting', reason: 'skipped with --skip' }]);

  const only = selectChecks({ only: ['hoisting'] });
  assert.ok(only.enabled.has('hoisting'), '--only hoisting keeps it');
  assert.ok(only.enabled.has('install'), '--only hoisting implies the install it reads from');

  // Dropping the install drops this too, and the run has to say so.
  const noInstall = selectChecks({ skip: ['install'] });
  assert.equal(noInstall.enabled.has('hoisting'), false);
  assert.ok(noInstall.skipped.some((s) => s.id === 'hoisting' && s.reason === 'needs the install check, which is not running'));
});

test('hoisting runs after peers and before lazy: the cheap rooms first', () => {
  assert.ok(CHECK_IDS.indexOf('hoisting') > CHECK_IDS.indexOf('peers'));
  assert.ok(CHECK_IDS.indexOf('hoisting') < CHECK_IDS.indexOf('lazy'));
});
