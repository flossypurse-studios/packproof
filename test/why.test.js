// The contract of --why: every check group has to say what it proves and what it
// does not, and the second list can never be empty. The test that matters here
// is the completeness one — a new check group added to CHECK_IDS without an
// entry in WHY fails the suite, which is the only way "the tool documents its
// own limits" survives contact with a future release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_IDS, CHECK_HELP, NEEDS_INSTALL } from '../src/select.js';
import { WHY, whyFor, whyText, whyIndex, whyAll, whyJson, whySummary, wrap } from '../src/why.js';

test('every check id has an entry, and every entry is a real check id', () => {
  for (const id of CHECK_IDS) assert.ok(WHY[id], `no --why entry for check "${id}"`);
  for (const id of Object.keys(WHY)) assert.ok(CHECK_IDS.includes(id), `WHY has unknown check "${id}"`);
  assert.equal(Object.keys(WHY).length, CHECK_IDS.length);
});

test('every entry says what it proves AND what it cannot', () => {
  for (const id of CHECK_IDS) {
    const e = WHY[id];
    assert.ok(Array.isArray(e.proves) && e.proves.length >= 1, `${id}: proves`);
    assert.ok(Array.isArray(e.cannot) && e.cannot.length >= 1, `${id}: cannot`);
    for (const line of [...e.proves, ...e.cannot]) {
      assert.equal(typeof line, 'string', id);
      assert.ok(line.trim().length > 20, `${id}: "${line}" is too short to be an honest claim`);
    }
  }
});

test('whySummary is the same one-liner --help and the report already use', () => {
  for (const id of CHECK_IDS) assert.equal(whySummary(id), CHECK_HELP[id]);
});

test('an unknown id is refused by naming the real ids, never by guessing', () => {
  const r = whyFor('instal');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown check "instal" in --why/);
  for (const id of CHECK_IDS) assert.ok(r.error.includes(id), id);
});

test('whyText prints the summary, both lists, and the install dependency where it applies', () => {
  for (const id of CHECK_IDS) {
    const { ok, text } = whyText(id);
    assert.equal(ok, true);
    assert.ok(text.startsWith(`${id} — ${CHECK_HELP[id]}`), id);
    assert.match(text, /A passing .+ check proves/);
    assert.match(text, /\n  It cannot\n/);
    // Every claim survives the wrapping: the first few words of each are findable.
    for (const line of [...WHY[id].proves, ...WHY[id].cannot]) {
      const head = line.split(/\s+/).slice(0, 4).join(' ');
      assert.ok(text.includes(head), `${id}: lost "${head}"`);
    }
    if (NEEDS_INSTALL.includes(id)) assert.match(text, /Needs the install check/);
    else assert.doesNotMatch(text, /Needs the install check/);
  }
});

test('the text wraps: nothing in --why all is wider than 80 columns', () => {
  for (const line of whyAll().split('\n')) {
    assert.ok(line.length <= 80, `too wide (${line.length}): ${line}`);
  }
  for (const line of whyIndex().split('\n')) {
    assert.ok(line.length <= 90, `too wide (${line.length}): ${line}`);
  }
});

test('wrap never loses or splits a word', () => {
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa'.split(' ');
  const out = wrap(words.join(' '), 20, '  ');
  assert.deepEqual(out.split('\n').join(' ').trim().split(/\s+/), words);
  for (const line of out.split('\n')) assert.ok(line.length <= 20, line);
  assert.equal(wrap(''), '');
});

test('the index lists every check, in run order', () => {
  const index = whyIndex();
  const positions = CHECK_IDS.map((id) => index.indexOf(`  ${id} `));
  for (const [i, p] of positions.entries()) assert.ok(p > 0, CHECK_IDS[i]);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('whyAll covers every check', () => {
  const all = whyAll();
  for (const id of CHECK_IDS) assert.ok(all.includes(`${id} — ${CHECK_HELP[id]}`), id);
});

test('whyJson carries the same content as data', () => {
  const all = whyJson();
  assert.equal(all.checks.length, CHECK_IDS.length);
  assert.deepEqual(all.checks.map((c) => c.id), CHECK_IDS);
  for (const c of all.checks) {
    assert.deepEqual(c.proves, WHY[c.id].proves);
    assert.deepEqual(c.cannot, WHY[c.id].cannot);
    assert.equal(c.summary, CHECK_HELP[c.id]);
    assert.equal(c.needsInstall, NEEDS_INSTALL.includes(c.id));
  }
  const one = whyJson(['diff']);
  assert.equal(one.checks.length, 1);
  assert.equal(one.checks[0].id, 'diff');
  // Mutating the copy cannot reach the map every other caller reads.
  one.checks[0].proves.push('nonsense');
  assert.ok(!WHY.diff.proves.includes('nonsense'));
});
