import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_IDS,
  CHECK_HELP,
  NEEDS_INSTALL,
  parseCheckList,
  selectChecks,
  verdictLine,
} from '../src/select.js';
import { junitXml, githubAnnotations, skippedOf } from '../src/format.js';

const ids = (sel) => [...sel.enabled];
const skippedIds = (sel) => sel.skipped.map((s) => s.id);

test('every check id has a help line', () => {
  for (const id of CHECK_IDS) assert.equal(typeof CHECK_HELP[id], 'string', id);
});

test('parseCheckList: repeatable and comma-splittable mean the same thing', () => {
  assert.deepEqual(parseCheckList(['a,b', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(parseCheckList(['a', 'b', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(parseCheckList([' a , b ']), ['a', 'b']);
  assert.deepEqual(parseCheckList(['a,,b', '']), ['a', 'b']);
  assert.deepEqual(parseCheckList(undefined), []);
});

test('no selection at all runs everything and is a full run', () => {
  const sel = selectChecks({});
  assert.equal(sel.ok, true);
  assert.deepEqual(ids(sel), CHECK_IDS);
  assert.deepEqual(sel.skipped, []);
  assert.equal(sel.full, true);
  assert.equal(sel.installed, true);
});

test('--skip install drops every check that needs an install, and names why', () => {
  const sel = selectChecks({ skip: ['install'] });
  assert.equal(sel.ok, true);
  assert.deepEqual(ids(sel), ['shipped-files', 'diff']);
  assert.equal(sel.installed, false);
  assert.deepEqual(skippedIds(sel), ['install', ...NEEDS_INSTALL]);
  const install = sel.skipped.find((s) => s.id === 'install');
  assert.match(install.reason, /--skip/);
  for (const id of NEEDS_INSTALL) {
    assert.match(sel.skipped.find((s) => s.id === id).reason, /install/);
  }
});

test('--only names exactly what runs; everything else is reported as not selected', () => {
  const sel = selectChecks({ only: ['shipped-files'] });
  assert.deepEqual(ids(sel), ['shipped-files']);
  assert.equal(sel.installed, false);
  assert.equal(sel.skipped.length, CHECK_IDS.length - 1);
  assert.match(sel.skipped.find((s) => s.id === 'bins').reason, /--only/);
});

test('--only on an import probe implies the install: it is a prerequisite', () => {
  const sel = selectChecks({ only: ['entries'] });
  assert.deepEqual(ids(sel), ['install', 'entries']);
  assert.equal(sel.installed, true);
});

test('--only entries --skip install is a refusal, not a coin flip', () => {
  const sel = selectChecks({ only: ['entries'], skip: ['install'] });
  assert.equal(sel.ok, false);
  assert.match(sel.error, /nothing can be imported/);
});

test('--only x --skip x is a refusal', () => {
  const sel = selectChecks({ only: ['bins'], skip: ['bins'] });
  assert.equal(sel.ok, false);
  assert.match(sel.error, /--only bins --skip bins/);
});

test('an unknown id lists the real ones instead of guessing at the typo', () => {
  const sel = selectChecks({ skip: ['instal'] });
  assert.equal(sel.ok, false);
  assert.match(sel.error, /unknown check "instal" in --skip/);
  for (const id of CHECK_IDS) assert.match(sel.error, new RegExp(id.replace('-', '\\-')));
  assert.doesNotMatch(sel.error, /did you mean/i);
});

test('an unknown id in --only says --only, not --skip', () => {
  assert.match(selectChecks({ only: ['nope'] }).error, /in --only/);
});

test('--only diff without --diff is refused: it would have nothing to compare', () => {
  assert.match(selectChecks({ only: ['diff'] }).error, /no --diff was passed/);
  assert.equal(selectChecks({ only: ['diff'], requested: { diff: true } }).ok, true);
});

test('--only lazy without --lazy is refused the same way', () => {
  assert.match(selectChecks({ only: ['lazy'] }).error, /no --lazy was passed/);
  const sel = selectChecks({ only: ['lazy'], requested: { lazy: true } });
  assert.deepEqual(ids(sel), ['install', 'lazy']);
});

test('asking for --diff and then selecting the diff check away is refused', () => {
  assert.match(selectChecks({ skip: ['diff'], requested: { diff: true } }).error, /pick one/);
  assert.match(
    selectChecks({ only: ['shipped-files'], requested: { diff: true } }).error,
    /--diff asks for the diff check/
  );
});

test('a flag that was never passed leaves its check enabled and unremarked', () => {
  // Nobody ran --diff, so the diff check is enabled but never reached: a full
  // run with no --diff must not start claiming it skipped something.
  const sel = selectChecks({});
  assert.equal(sel.full, true);
  assert.ok(sel.enabled.has('diff'));
});

test('skipping literally everything is refused rather than reported as green', () => {
  const sel = selectChecks({ skip: CHECK_IDS });
  assert.equal(sel.ok, false);
  assert.match(sel.error, /nothing left to prove/);
});

test('--skip is order-independent and tolerates repeats', () => {
  const a = selectChecks({ skip: ['bins,engines'] });
  const b = selectChecks({ skip: ['engines', 'bins', 'bins'] });
  assert.deepEqual(ids(a), ids(b));
  assert.deepEqual(skippedIds(a), ['bins', 'engines']);
});

// --- the verdict line: what a partial run is allowed to claim ---

test('a full clean run still says the one thing it has always said', () => {
  assert.equal(verdictLine(selectChecks({}), { failures: 0 }), 'this package works when installed.');
});

test('a clean run that never installed may not claim the package installs', () => {
  const line = verdictLine(selectChecks({ skip: ['install'] }), { failures: 0 });
  assert.doesNotMatch(line, /works when installed/);
  assert.match(line, /never installed the package/);
  assert.match(line, /Skipped: install, entries, require, bins, engines, peers, lazy/);
});

test('a clean run that installed but dropped a probe says it is not a full proof', () => {
  const line = verdictLine(selectChecks({ skip: ['engines'] }), { failures: 0 });
  assert.match(line, /works when installed/);
  assert.match(line, /not a full proof/);
  assert.match(line, /\(engines\)/);
});

test('a failing partial run still leads with the failures', () => {
  const line = verdictLine(selectChecks({ skip: ['engines'] }), { failures: 2 });
  assert.match(line, /^2 problems your users would hit\./);
  assert.match(line, /1 check was skipped \(engines\)/);
});

// --- the machine formats have to carry it too ---

const partialResult = {
  name: 'demo',
  version: '1.0.0',
  durationMs: 1000,
  fileCount: 3,
  installed: false,
  fullRun: false,
  ok: true,
  checks: [{ name: 'shipped files', pass: true }],
  skippedChecks: [
    { id: 'install', reason: 'skipped with --skip' },
    { id: 'entries', reason: 'needs the install check, which is not running' },
  ],
};

test('junit: a check that did not run is a skipped testcase, not an absent one', () => {
  const xml = junitXml(partialResult);
  assert.match(xml, /tests="3" failures="0" errors="0" skipped="2"/);
  assert.match(xml, /<testcase name="install" classname="demo">\n\s+<skipped message="skipped with --skip" \/>/);
  assert.match(xml, /<testcase name="entries" classname="demo">/);
});

test('github: a clean partial run gets a notice saying what did not run', () => {
  const out = githubAnnotations(partialResult);
  assert.match(out, /::notice title=packproof::.*2 checks did not run \(install, entries\)/);
  assert.match(out, /never installed/);
  // ...and the clean notice must not claim it installs.
  assert.doesNotMatch(out.split('\n')[0], /installs clean/);
});

test('github: a failing partial run still gets the skipped notice', () => {
  const failing = {
    ...partialResult,
    ok: false,
    checks: [{ name: 'shipped files', pass: false, kind: 'shipped-secret', hint: 'remove it' }],
  };
  const out = githubAnnotations(failing);
  assert.match(out, /^::error /m);
  assert.match(out, /^::notice title=packproof::.*did not run/m);
});

test('a full run adds no skipped notice and no skipped testcases', () => {
  const full = { ...partialResult, installed: true, fullRun: true, skippedChecks: [] };
  assert.doesNotMatch(githubAnnotations(full), /did not run/);
  assert.match(junitXml(full), /skipped="0"/);
  assert.doesNotMatch(junitXml(full), /<skipped/);
  assert.deepEqual(skippedOf(full), []);
});

test('skippedOf collapses a workspace run to one list', () => {
  const ws = {
    packages: [partialResult, { ...partialResult, name: 'other' }],
    skippedChecks: partialResult.skippedChecks,
  };
  assert.deepEqual(
    skippedOf(ws).map((s) => s.id),
    ['install', 'entries']
  );
});

test('--node without the engines check is a contradiction, however it was written', () => {
  const skipped = selectChecks({ skip: ['engines'], requested: { node: true } });
  assert.equal(skipped.ok, false);
  assert.match(skipped.error, /--node names the Node the engines check runs under and --skip engines removes that check/);

  const notSelected = selectChecks({ only: ['entries'], requested: { node: true } });
  assert.equal(notSelected.ok, false);
  assert.match(notSelected.error, /--only entries removes that check/);

  const noInstall = selectChecks({ skip: ['install'], requested: { node: true } });
  assert.equal(noInstall.ok, false);
  assert.match(noInstall.error, /--skip install removes that check/, 'name the cause the caller wrote');

  assert.equal(selectChecks({ requested: { node: true } }).ok, true);
  assert.equal(selectChecks({ only: ['engines'], requested: { node: true } }).ok, true);
});
