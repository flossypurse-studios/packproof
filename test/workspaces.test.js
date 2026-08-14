// Workspace (monorepo) tests. The contract: every package in the workspace gets
// its OWN clean room, its own report section, and its own file paths — and a
// dependency on a sibling package is reported as what it is, not as a missing
// dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { packproofWorkspaces } from '../src/index.js';
import {
  npmWorkspaceGlobs,
  pnpmWorkspaceGlobs,
  findWorkspacePackages,
  siblingDependencies,
  siblingInstallFailure,
  releaseOrder,
} from '../src/workspaces.js';
import { junitXml, githubAnnotations } from '../src/format.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cli = join(root, 'src', 'cli.js');
const fixture = (n) => join(here, 'fixtures', n);
const TIMEOUT = 240000;

function run(args, { cwd = root } = {}) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

// --- discovery -------------------------------------------------------------

test('workspace globs are read from either shape of the workspaces field', () => {
  assert.deepEqual(npmWorkspaceGlobs({ workspaces: ['packages/*'] }), ['packages/*']);
  assert.deepEqual(npmWorkspaceGlobs({ workspaces: { packages: ['a', 'b'] } }), ['a', 'b']);
  assert.deepEqual(npmWorkspaceGlobs({}), []);
  assert.deepEqual(npmWorkspaceGlobs({ workspaces: {} }), []);
});

test('pnpm-workspace.yaml globs are read without a YAML dependency', () => {
  const text = [
    'packages:',
    "  - 'packages/*'",
    '  - "apps/**"',
    '  - libs/one   # trailing comment',
    '  - !packages/skip',
    '',
    'onlyBuiltDependencies:',
    '  - esbuild',
  ].join('\n');
  assert.deepEqual(pnpmWorkspaceGlobs(text), ['packages/*', 'apps/**', 'libs/one', '!packages/skip']);
  assert.deepEqual(pnpmWorkspaceGlobs('# nothing here\n'), []);
});

test('a workspace root that declares nothing says so instead of passing empty', () => {
  assert.throws(() => findWorkspacePackages(fixture('good-cjs')), /no workspaces declared/);
});

test('packages are discovered across several globs and sorted by name', () => {
  const found = findWorkspacePackages(fixture('monorepo-basic'));
  assert.equal(found.source, 'package.json');
  assert.deepEqual(
    found.packages.map((p) => `${p.name}:${p.rel}`),
    [
      'pp-fixture-mono-alpha:packages/alpha',
      'pp-fixture-mono-beta:packages/beta',
      'pp-fixture-mono-web:apps/web',
    ]
  );
  assert.equal(found.packages.find((p) => p.name === 'pp-fixture-mono-web').private, true);
});

test('sibling dependencies are recognised across dependency fields', () => {
  const siblings = new Set(['a', 'b', 'c']);
  const deps = siblingDependencies(
    { dependencies: { a: 'workspace:*', z: '^1' }, peerDependencies: { b: '^2.0.0' } },
    siblings
  );
  assert.deepEqual(
    deps.map((d) => [d.name, d.range, d.field, d.protocol]),
    [
      ['a', 'workspace:*', 'dependencies', true],
      ['b', '^2.0.0', 'peerDependencies', false],
    ]
  );
  assert.equal(siblingDependencies({ dependencies: { z: '^1' } }, siblings).length, 0);
});

test('an install failure is only blamed on a sibling when the sibling is implicated', () => {
  const deps = [{ name: 'sib', range: 'workspace:*', protocol: true }];
  assert.ok(siblingInstallFailure('npm error code EUNSUPPORTEDPROTOCOL', deps));
  assert.ok(siblingInstallFailure("npm error 404 'sib@1.0.0' is not in this registry", deps));
  assert.equal(siblingInstallFailure('npm error ETARGET no matching version for other', deps), null);
  assert.equal(siblingInstallFailure('anything at all', []), null);
});

// --- end to end ------------------------------------------------------------

test('every workspace package is proved in its own clean room', { timeout: TIMEOUT }, async () => {
  const r = await packproofWorkspaces(fixture('monorepo-basic'));
  assert.equal(r.workspaces, true);
  assert.equal(r.packageCount, 2, 'the private app is not proved');
  assert.equal(r.ok, false);
  assert.equal(r.okCount, 1);
  assert.deepEqual(r.skipped, [{ name: 'pp-fixture-mono-web', dir: 'apps/web', reason: 'private' }]);

  const [alpha, beta] = r.packages;
  assert.equal(alpha.name, 'pp-fixture-mono-alpha');
  assert.equal(alpha.ok, true);
  assert.equal(beta.name, 'pp-fixture-mono-beta');
  assert.deepEqual(
    beta.failures.map((f) => f.kind),
    ['undeclared-dependency']
  );
  // the failure carries which package it came from, for a flat consumer
  assert.deepEqual(r.failures.map((f) => f.package), ['pp-fixture-mono-beta']);
  // each package's version is its own, not the root's
  assert.equal(beta.version, '2.0.0');
});

test('pathPrefix stays per package so CI points at the right file', { timeout: TIMEOUT }, async () => {
  const r = await packproofWorkspaces('test/fixtures/monorepo-basic');
  assert.deepEqual(
    r.packages.map((p) => p.pathPrefix),
    ['test/fixtures/monorepo-basic/packages/alpha', 'test/fixtures/monorepo-basic/packages/beta']
  );
});

test('--include-private proves the packages nobody installs, when asked', { timeout: TIMEOUT }, async () => {
  const r = await packproofWorkspaces(fixture('monorepo-basic'), { includePrivate: true });
  assert.equal(r.packageCount, 3);
  assert.deepEqual(r.skipped, []);
});

test('--workspace selects one package, by name or by directory', { timeout: TIMEOUT }, async () => {
  const byName = await packproofWorkspaces(fixture('monorepo-basic'), {
    workspace: ['pp-fixture-mono-alpha'],
  });
  assert.deepEqual(byName.packages.map((p) => p.name), ['pp-fixture-mono-alpha']);
  assert.equal(byName.ok, true);
  const byDir = await packproofWorkspaces(fixture('monorepo-basic'), { workspace: ['packages/beta'] });
  assert.deepEqual(byDir.packages.map((p) => p.name), ['pp-fixture-mono-beta']);
  assert.equal(byDir.ok, false);
});

test('an unknown --workspace name is an error that lists the real ones', { timeout: TIMEOUT }, async () => {
  await assert.rejects(
    () => packproofWorkspaces(fixture('monorepo-basic'), { workspace: ['nope'] }),
    /no workspace package named nope.*pp-fixture-mono-alpha/s
  );
});

test(
  'a dependency on a sibling workspace package is its own kind, not a missing dependency',
  { timeout: TIMEOUT },
  async () => {
    const r = await packproofWorkspaces(fixture('monorepo-siblings'));
    assert.equal(r.ok, false);
    const wrapper = r.packages.find((p) => p.name === 'pp-fixture-mono-wrapper');
    assert.deepEqual(wrapper.failures.map((f) => f.kind), ['workspace-sibling-dependency']);
    const f = wrapper.failures[0];
    assert.deepEqual(f.siblings, ['pp-fixture-mono-core']);
    assert.match(f.hint, /pp-fixture-mono-core@workspace:\*/);
    assert.match(f.hint, /registry, not from your checkout/);
    assert.match(f.hint, /workspace: range never resolves/);
    assert.ok(!/undeclared/.test(f.hint), 'it is not pretending the dependency is missing');
    // the sibling itself is fine, and is proved independently
    assert.equal(r.packages.find((p) => p.name === 'pp-fixture-mono-core').ok, true);
  }
);

test('a sibling that is not depended on changes nothing', { timeout: TIMEOUT }, async () => {
  const r = await packproofWorkspaces(fixture('monorepo-basic'));
  const alpha = r.packages[0];
  assert.equal(alpha.checks.find((c) => c.name === 'npm install <tarball>').note, undefined);
});

// --- formatters ------------------------------------------------------------

test('--format=junit emits one testsuite per package inside one testsuites', { timeout: TIMEOUT }, async () => {
  const r = await packproofWorkspaces('test/fixtures/monorepo-basic');
  const xml = junitXml(r);
  assert.equal((xml.match(/<testsuites /g) || []).length, 1);
  const suites = xml.match(/<testsuite name="[^"]+"/g) || [];
  assert.deepEqual(suites, [
    '<testsuite name="pp-fixture-mono-alpha@1.0.0"',
    '<testsuite name="pp-fixture-mono-beta@2.0.0"',
  ]);
  // the wrapper counts every check in the workspace
  const total = r.packages.reduce((n, p) => n + p.checks.length, 0);
  assert.match(xml, new RegExp(`<testsuites name="packproof" tests="${total}" failures="1"`));
  assert.match(xml, /<failure type="undeclared-dependency"/);
  assert.match(xml, /classname="pp-fixture-mono-beta"/);
});

test('--format=github annotates each package at its own path', { timeout: TIMEOUT }, async () => {
  const r = await packproofWorkspaces('test/fixtures/monorepo-siblings', { lazy: true });
  const out = githubAnnotations(r);
  for (const l of out.split('\n').filter(Boolean)) assert.match(l, /^::(error|warning|notice) /);
  assert.match(out, /title=workspace-sibling-dependency::/);
});

test('a clean workspace is one notice, not silence', { timeout: TIMEOUT }, async () => {
  const r = await packproofWorkspaces(fixture('monorepo-basic'), { workspace: ['pp-fixture-mono-alpha'] });
  const lines = githubAnnotations(r).split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::notice title=packproof::1 package in pp-fixture-mono installs clean/);
});

// --- the binary ------------------------------------------------------------

test('the CLI prints one section per package and exits 1 on any problem', { timeout: TIMEOUT }, () => {
  const r = run(['test/fixtures/monorepo-basic', '--workspaces']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^pp-fixture-mono .*2 packages from package\.json/m);
  assert.match(r.stdout, /^pp-fixture-mono-alpha@1\.0\.0 packages\/alpha/m);
  assert.match(r.stdout, /^pp-fixture-mono-beta@2\.0\.0 packages\/beta/m);
  assert.match(r.stdout, /skipped, private/);
  assert.match(r.stdout, /1 problem your users would hit, in 1 of 2 packages \(pp-fixture-mono-beta\)/);
});

test('a clean workspace exits 0 and says so', { timeout: TIMEOUT }, () => {
  const r = run(['test/fixtures/monorepo-basic', '--workspace', 'pp-fixture-mono-alpha']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /all 1 package works when installed\./);
});

test('--workspaces on a package that is not a workspace root is exit 2', { timeout: TIMEOUT }, () => {
  const r = run(['test/fixtures/good-cjs', '--workspaces']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no workspaces declared/);
});

test('--workspaces and --registry cannot be combined', () => {
  const r = run(['--workspaces', '--registry', 'packproof@0.4.0']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /pick one/);
});

test('--workspaces --json is one document describing the whole workspace', { timeout: TIMEOUT }, () => {
  const r = run(['test/fixtures/monorepo-basic', '--workspaces', '--json']);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.workspaces, true);
  assert.equal(j.packages.length, 2);
  assert.equal(j.skipped.length, 1);
  assert.equal(j.ok, false);
  assert.equal(j.failures[0].package, 'pp-fixture-mono-beta');
});

test('a single-package run is untouched by any of this', { timeout: TIMEOUT }, () => {
  const a = run(['test/fixtures/good-cjs']);
  assert.equal(a.code, 0);
  assert.match(a.stdout, /^pp-fixture-good-cjs@1\.0\.0 — \d+ files packed$/m, 'no workspace dir on a plain run');
  assert.match(a.stdout, /packproof: this package works when installed\./);
});

// --- release order ---------------------------------------------------------
//
// After --workspaces finds a sibling dependency, packproof knows enough to say
// what to do about it: publish the leaves first. The contract here is that the
// order is a topological sort over the workspace's own packages, that it is
// deterministic, and that a genuine cycle is reported as a cycle instead of
// being flattened into an order that cannot work.

const node = (name, deps, extra = {}) => ({
  name,
  version: '1.0.0',
  rel: `packages/${name}`,
  private: false,
  manifest: { name, version: '1.0.0', dependencies: deps || undefined, ...extra },
});

test('release order puts a dependency before the package that needs it', () => {
  const r = releaseOrder([
    node('c', { b: '^1.0.0' }),
    node('a', null),
    node('b', { a: 'workspace:*' }),
  ]);
  assert.deepEqual(r.cycles, []);
  assert.deepEqual(r.steps.map((s) => [s.step, s.name, s.needs]), [
    [1, 'a', []],
    [2, 'b', ['a']],
    [3, 'c', ['b']],
  ]);
  assert.deepEqual(r.waves, [['a'], ['b'], ['c']]);
  assert.equal(r.edgeCount, 2);
});

test('packages that depend on nothing in the workspace share step 1', () => {
  const r = releaseOrder([node('one', null), node('two', null), node('three', { one: '^1' })]);
  assert.deepEqual(r.waves, [['one', 'two'], ['three']]);
  assert.equal(r.edgeCount, 1);
});

test('a workspace with no sibling dependencies has no order to give', () => {
  const r = releaseOrder([node('one', null), node('two', null)]);
  assert.equal(r.edgeCount, 0);
  assert.deepEqual(r.waves, [['one', 'two']]);
  assert.deepEqual(r.cycles, []);
});

test('release order ignores ranges on packages outside the workspace', () => {
  const r = releaseOrder([node('one', { lodash: '^4' }), node('two', { one: '^1', react: '^18' })]);
  assert.equal(r.edgeCount, 1);
  assert.deepEqual(r.waves, [['one'], ['two']]);
});

test('a dependency declared twice counts as one edge', () => {
  const r = releaseOrder([node('one', null), node('two', { one: '^1' }, { peerDependencies: { one: '^1' } })]);
  assert.equal(r.edgeCount, 1);
  assert.deepEqual(r.steps[1].needs, ['one']);
});

test('a cycle is reported as a cycle instead of a bogus order', () => {
  const r = releaseOrder([node('a', { b: '^1' }), node('b', { a: '^1' }), node('c', { a: '^1' })]);
  assert.equal(r.steps, null, 'no order is claimed when none exists');
  assert.equal(r.waves, null);
  assert.equal(r.cycles.length, 1);
  assert.deepEqual(r.cycles[0].packages, ['a', 'b']);
  assert.deepEqual(r.cycles[0].path, ['a', 'b', 'a']);
  // c is not in the cycle but cannot be ordered either, and says so
  assert.deepEqual(r.unordered, ['a', 'b', 'c']);
});

test('two independent cycles are reported separately', () => {
  const r = releaseOrder([
    node('a', { b: '^1' }),
    node('b', { a: '^1' }),
    node('y', { z: '^1' }),
    node('z', { y: '^1' }),
  ]);
  assert.deepEqual(
    r.cycles.map((c) => c.packages),
    [['a', 'b'], ['y', 'z']]
  );
});

test('a package that depends on itself is not a cycle', () => {
  const r = releaseOrder([node('a', { a: '^1' }), node('b', { a: '^1' })]);
  assert.deepEqual(r.cycles, []);
  assert.deepEqual(r.waves, [['a'], ['b']]);
});

test('release order is discovered from a real workspace on disk', () => {
  const found = findWorkspacePackages(fixture('monorepo-chain'));
  const r = releaseOrder(found.packages);
  assert.deepEqual(r.steps.map((s) => s.name), [
    'pp-fixture-chain-a',
    'pp-fixture-chain-b',
    'pp-fixture-chain-c',
  ]);
  // c needs both, through dependencies and peerDependencies
  assert.deepEqual(r.steps[2].needs, ['pp-fixture-chain-a', 'pp-fixture-chain-b']);
  assert.deepEqual(r.steps[1].dir, 'packages/b');
});

test('a cycle on disk is reported honestly', () => {
  const found = findWorkspacePackages(fixture('monorepo-cycle'));
  const r = releaseOrder(found.packages);
  assert.equal(r.steps, null);
  assert.deepEqual(r.cycles[0].packages, ['pp-fixture-cycle-left', 'pp-fixture-cycle-right']);
});

test('the release order rides along on the workspace result', { timeout: TIMEOUT }, async () => {
  // --workspace narrows what gets proved; the order is still the whole
  // workspace's, because that is the question it answers.
  const r = await packproofWorkspaces(fixture('monorepo-chain'), { workspace: ['pp-fixture-chain-a'] });
  assert.equal(r.packageCount, 1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.releaseOrder.steps.map((s) => s.name), [
    'pp-fixture-chain-a',
    'pp-fixture-chain-b',
    'pp-fixture-chain-c',
  ]);
  assert.deepEqual(r.releaseOrder.cycles, []);
});

test('private packages are left out of the release order', { timeout: TIMEOUT }, async () => {
  const r = await packproofWorkspaces(fixture('monorepo-basic'), { workspace: ['pp-fixture-mono-alpha'] });
  assert.deepEqual(r.releaseOrder.waves, [['pp-fixture-mono-alpha', 'pp-fixture-mono-beta']]);
  const withPrivate = await packproofWorkspaces(fixture('monorepo-basic'), {
    workspace: ['pp-fixture-mono-alpha'],
    includePrivate: true,
  });
  assert.ok(withPrivate.releaseOrder.waves[0].includes('pp-fixture-mono-web'));
});

test('the CLI prints the release order after the package sections', { timeout: TIMEOUT }, () => {
  const r = run(['test/fixtures/monorepo-chain', '--workspace', 'pp-fixture-chain-a']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^release order — 3 steps/m);
  assert.match(r.stdout, /^ {2}1\. pp-fixture-chain-a$/m);
  assert.match(r.stdout, /^ {2}2\. pp-fixture-chain-b +— needs pp-fixture-chain-a$/m);
  assert.match(r.stdout, /^ {2}3\. pp-fixture-chain-c +— needs pp-fixture-chain-a, pp-fixture-chain-b$/m);
  // the summary still has the last word
  const orderAt = r.stdout.indexOf('release order');
  assert.ok(orderAt > r.stdout.indexOf('pp-fixture-chain-a@1.0.0'));
  assert.ok(orderAt < r.stdout.indexOf('packproof: all 1 package works'));
});

test('the CLI says so when no package depends on another', { timeout: TIMEOUT }, () => {
  const r = run(['test/fixtures/monorepo-basic', '--workspaces']);
  assert.match(r.stdout, /^release order — any order works: no package here depends on another$/m);
});

test('the CLI reports a cycle instead of an order', { timeout: TIMEOUT }, () => {
  const r = run(['test/fixtures/monorepo-cycle', '--workspace', 'pp-fixture-cycle-left']);
  assert.match(r.stdout, /^release order — none exists \[workspace-dependency-cycle\]$/m);
  assert.match(r.stdout, /pp-fixture-cycle-left → pp-fixture-cycle-right → pp-fixture-cycle-left/);
  assert.match(r.stdout, /depend on each other/);
});

test('--workspaces --json carries the release order for machines', { timeout: TIMEOUT }, () => {
  const r = run(['test/fixtures/monorepo-chain', '--workspaces', '--workspace', 'pp-fixture-chain-a', '--json']);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.releaseOrder.waves, [
    ['pp-fixture-chain-a'],
    ['pp-fixture-chain-b'],
    ['pp-fixture-chain-c'],
  ]);
  assert.equal(j.releaseOrder.cycles.length, 0);
  // b needs a (1 edge); c needs b (dependencies) and a (peerDependencies) — 2 more.
  assert.equal(j.releaseOrder.edgeCount, 3);
});

test('a single-package run has no release order at all', { timeout: TIMEOUT }, () => {
  const r = run(['test/fixtures/good-cjs', '--json']);
  const j = JSON.parse(r.stdout);
  assert.equal(j.releaseOrder, undefined, 'release order is a workspace question only');
});
