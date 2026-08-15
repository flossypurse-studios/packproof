// End-to-end tests through the actual binary: exit codes, stdout shape, --out.
// The contract these defend: the default human output is byte-identical to what
// it has always been, and every other format is opt-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cli = join(root, 'src', 'cli.js');
const TIMEOUT = 180000;

function run(args, { cwd = root } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('default output is byte-identical to --format=human', { timeout: TIMEOUT }, async () => {
  const target = 'test/fixtures/good-cjs';
  const a = run([target]);
  const b = run([target, '--format=human']);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.equal(a.stdout, b.stdout);
  assert.match(a.stdout, /packproof: this package works when installed\./);
});

test('--format=github on a clean package is a single notice and exit 0', { timeout: TIMEOUT }, async () => {
  const r = run(['test/fixtures/good-cjs', '--format=github']);
  assert.equal(r.code, 0);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::notice title=packproof::pp-fixture-good-cjs@1\.0\.0 installs clean/);
});

test('--format=github anchors a --lazy failure to the file and line in the checkout', { timeout: TIMEOUT }, async () => {
  const r = run(['test/fixtures/broken-lazy-devdep', '--lazy', '--format=github']);
  assert.equal(r.code, 1, 'a user-visible problem is still exit 1');
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.match(l, /^::(error|warning|notice) /, 'nothing but annotations on stdout');
  assert.ok(
    lines.some((l) => l.includes('file=test/fixtures/broken-lazy-devdep/index.js,line=10,')),
    `expected a file-anchored annotation, got:\n${r.stdout}`
  );
  assert.ok(lines.some((l) => l.includes('title=undeclared-dependency::')));
  assert.ok(!r.stdout.includes('\n::error file=test/fixtures/broken-lazy-devdep/index.js,line=10, '), 'no stray spaces');
});

test('--format=junit writes a report to --out and leaves stdout empty', { timeout: TIMEOUT }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'packproof-junit-'));
  const out = join(dir, 'nested', 'packproof.xml');
  try {
    const r = run(['test/fixtures/broken-lazy-devdep', '--lazy', '--format=junit', '--out', out]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.ok(existsSync(out), 'the report file was created, parent directory and all');
    const xml = readFileSync(out, 'utf8');
    assert.match(xml, /<testsuites name="packproof" tests="\d+" failures="1" errors="0"/);
    assert.match(xml, /file="test\/fixtures\/broken-lazy-devdep\/index\.js" line="10"/);
    assert.match(xml, /<failure type="undeclared-dependency"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--format=junit with no --out goes to stdout', { timeout: TIMEOUT }, async () => {
  const r = run(['test/fixtures/good-esm', '--format=junit']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^<\?xml version="1\.0"/);
  assert.match(r.stdout, /failures="0"/);
});

test('--json is still exactly --format=json', { timeout: TIMEOUT }, async () => {
  const a = run(['test/fixtures/good-esm', '--json']);
  const b = run(['test/fixtures/good-esm', '--format=json']);
  assert.equal(a.code, 0);
  const pa = JSON.parse(a.stdout);
  const pb = JSON.parse(b.stdout);
  assert.equal(pa.name, 'pp-fixture-good-esm');
  assert.equal(pa.ok, true);
  assert.equal(pb.ok, true);
});

test('an unknown format is a packproof error: exit 2, and it lists the real ones', () => {
  const r = run(['--format=teamcity']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown format "teamcity"/);
  assert.match(r.stderr, /human, json, github, junit/);
});

test('a packproof error in github format is an annotation, not a bare stderr line', () => {
  const r = run(['test/fixtures', '--format=github']);
  assert.equal(r.code, 2, 'a packproof error is exit 2');
  assert.match(r.stdout, /^::error title=packproof::no package\.json found/);
});

test('a packproof error in junit format is an <error> testcase', () => {
  const r = run(['test/fixtures', '--format=junit']);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /errors="1"/);
  assert.match(r.stdout, /<error type="packproof" message="no package\.json found/);
});

test('--help mentions the CI formats', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--format/);
  assert.match(r.stdout, /github/);
});

test('--help documents --diff', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--diff \[version\]/);
});

test('--diff with a version and --workspaces is refused, not guessed at', () => {
  const r = run(['--workspaces', '--diff', '1.0.0']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /use a bare --diff/);
});

test('a bare --diff is accepted alongside --workspaces', () => {
  // It gets as far as workspace discovery, which is proof the guard let it past.
  const r = run(['test/fixtures/good-cjs', '--workspaces', '--diff']);
  assert.doesNotMatch(r.stderr || '', /use a bare --diff/);
});

test('--strict is documented in --help', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--strict\s+fail on everything packproof would otherwise only note/);
});

// --- --only / --skip through the real binary ---

test('--skip install runs without a clean room and refuses to claim it installs', { timeout: TIMEOUT }, async () => {
  const r = run(['test/fixtures/good-cjs', '--skip', 'install']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /✓ shipped files/);
  assert.doesNotMatch(r.stdout, /works when installed/);
  assert.match(r.stdout, /never installed the package/);
  assert.match(r.stdout, /- entries — did not run, needs the install check/);
});

test('--only shipped-files runs exactly one check', { timeout: TIMEOUT }, async () => {
  const r = run(['test/fixtures/good-cjs', '--only', 'shipped-files']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.split('\n').filter((l) => l.includes('✓')).length, 1);
  assert.match(r.stdout, /not selected by --only/);
});

test('--only and --skip are repeatable and comma-splittable', { timeout: TIMEOUT }, async () => {
  const a = run(['test/fixtures/good-cjs', '--skip', 'install,diff']);
  const b = run(['test/fixtures/good-cjs', '--skip', 'install', '--skip=diff']);
  assert.equal(a.code, 0);
  assert.equal(a.stdout, b.stdout);
});

test('a contradiction exits 2 before anything is packed', { timeout: TIMEOUT }, async () => {
  const r = run(['test/fixtures/good-cjs', '--only', 'entries', '--skip', 'install']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /nothing can be imported/);
  assert.equal(r.stdout, '');
});

test('an unknown check id lists the real ones', { timeout: TIMEOUT }, async () => {
  const r = run(['test/fixtures/good-cjs', '--skip', 'instal']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown check "instal" in --skip/);
  assert.match(r.stderr, /shipped-files, diff, install, entries, require, bins, engines, peers, lazy/);
});

test('--only still fails the run when the check it selected fails', { timeout: TIMEOUT }, async () => {
  const r = run(['test/fixtures/broken-bin-no-shebang', '--only', 'bins']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /problem/);
  // the install ran because bins needs it, and nothing else was probed
  assert.doesNotMatch(r.stdout, /import "/);
});

test('a partial run in json carries skippedChecks and installed:false', { timeout: TIMEOUT }, async () => {
  const r = run(['test/fixtures/good-cjs', '--only', 'shipped-files', '--json']);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.installed, false);
  assert.equal(out.fullRun, false);
  assert.ok(out.skippedChecks.some((s) => s.id === 'install'));
});

test('a full run still reports nothing skipped', { timeout: TIMEOUT }, async () => {
  const r = run(['test/fixtures/good-cjs', '--json']);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.skippedChecks, []);
  assert.equal(out.fullRun, true);
  assert.equal(out.installed, true);
});

test('--help names every check id', { timeout: TIMEOUT }, async () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  for (const id of ['shipped-files', 'diff', 'install', 'entries', 'require', 'bins', 'engines', 'peers', 'lazy']) {
    assert.match(r.stdout, new RegExp(`\\n  ${id}\\s`));
  }
});

test('--node refuses a version this machine does not have, before packing anything', () => {
  const r = run(['test/fixtures/good-cjs', '--node', '999']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--node 999: no node 999 is installed/);
  assert.equal(r.stdout, '', 'nothing was packed');
});

test('--node refuses a value it cannot use, and says what the flag takes', () => {
  const missing = run(['test/fixtures/good-cjs', '--node']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--node needs a value/);

  const notNode = run(['test/fixtures/good-cjs', '--node', '/definitely/not/here/node']);
  assert.equal(notNode.code, 2);
  assert.match(notNode.stderr, /could not run it/);
});

test('--node with --skip engines is refused rather than resolved', () => {
  const r = run(['test/fixtures/good-cjs', '--node', '18', '--skip', 'engines']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--node names the Node the engines check runs under/);
});

test('--node <path to a real node> runs the engines check under it', { timeout: TIMEOUT }, async () => {
  // process.execPath is the one node every machine running this test has.
  const r = run(['test/fixtures/good-cjs', '--node', process.execPath, '--json']);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  const running = process.version.replace(/^v/, '');
  const engines = out.checks.filter((c) => c.node === running);
  assert.equal(engines.length, 1, `expected one check run under ${running}: ${JSON.stringify(out.checks.map((c) => c.name))}`);
  assert.equal(engines[0].pass, true);
  // The fixture declares no engines.node, so the report says so instead of
  // pretending the run confirmed a promise nobody made.
  assert.match(engines[0].name, new RegExp(`node v${running.replace(/\./g, '\\.')}, which nothing declares`));
});

test('--help documents --node', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\n  --node <ver\|path>/);
});
