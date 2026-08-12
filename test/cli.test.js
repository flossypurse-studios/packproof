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
