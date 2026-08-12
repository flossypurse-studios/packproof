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
