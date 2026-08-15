// Unit tests for the CI-shaped output formats. These are pure string tests: no
// packing, no installing. The escaping rules are the whole risk here — Actions
// silently mangles an annotation whose message contains a raw newline or %.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeData, escapeProp, githubAnnotations, junitXml, FORMATS } from '../src/format.js';

function result(over = {}) {
  return {
    name: 'demo',
    version: '1.2.3',
    source: 'local',
    pathPrefix: '',
    fileCount: 4,
    durationMs: 1234,
    checks: [],
    failures: [],
    ok: true,
    ...over,
  };
}

const fail = (over = {}) => ({ pass: false, kind: 'undeclared-dependency', name: 'a check', ...over });

test('escapeData: only %, CR and LF', () => {
  assert.equal(escapeData('100% done'), '100%25 done');
  assert.equal(escapeData('a\r\nb'), 'a%0D%0Ab');
  assert.equal(escapeData('a,b:c'), 'a,b:c');
  // % is escaped first, so an escape sequence is never double-escaped
  assert.equal(escapeData('%0A'), '%250A');
  assert.equal(escapeData(undefined), '');
});

test('escapeProp: also colons and commas, which delimit properties', () => {
  assert.equal(escapeProp('src/a.js'), 'src/a.js');
  assert.equal(escapeProp('a,b'), 'a%2Cb');
  assert.equal(escapeProp('C:\\x'), 'C%3A\\x');
  assert.equal(escapeProp('50%,x\n'), '50%25%2Cx%0A');
});

test('a failure with file and line becomes a file-anchored error annotation', () => {
  const chk = fail({ name: 'require("ghost") in src/a.js:10', file: 'src/a.js', line: 10, hint: 'add it' });
  const out = githubAnnotations(result({ ok: false, checks: [chk], failures: [chk] }));
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::error file=src\/a\.js,line=10,title=undeclared-dependency::/);
  // A colon is only special in a *property*; in the message it is plain data.
  assert.match(lines[0], /::require\("ghost"\) in src\/a\.js:10%0Aadd it$/);
});

test('a failure with no file degrades to a bare error annotation', () => {
  const chk = fail({ name: 'npm install <tarball>', kind: 'install-failed', hint: 'it did not install' });
  const out = githubAnnotations(result({ ok: false, checks: [chk], failures: [chk] }));
  assert.equal(out.trim(), '::error title=install-failed::npm install <tarball>%0Ait did not install');
});

test('newlines in hint and detail are folded into %0A, never emitted raw', () => {
  const chk = fail({ name: 'x', hint: 'line one\nline two', detail: 'd1\nd2' });
  const out = githubAnnotations(result({ ok: false, checks: [chk], failures: [chk] })).trim();
  assert.equal(out.split('\n').length, 1, 'one annotation is one physical line');
  assert.match(out, /line one%0Aline two%0Ad1%0Ad2/);
});

test('a message containing a percent sign and a comma is escaped as data, not as a property', () => {
  const chk = fail({ name: 'coverage 50% of files, roughly' });
  const out = githubAnnotations(result({ ok: false, checks: [chk], failures: [chk] })).trim();
  assert.match(out, /::coverage 50%25 of files, roughly$/);
});

test('the path is prefixed when the target is not the working directory', () => {
  const chk = fail({ file: 'src/a.js', line: 3, name: 'x' });
  const out = githubAnnotations(
    result({ ok: false, pathPrefix: 'packages/demo', checks: [chk], failures: [chk] })
  );
  assert.match(out, /file=packages\/demo\/src\/a\.js,line=3,/);
});

test('registry mode never claims a file in the checkout', () => {
  const chk = fail({ file: 'src/a.js', line: 3, name: 'x' });
  const out = githubAnnotations(
    result({ ok: false, source: 'registry', pathPrefix: '', checks: [chk], failures: [chk] })
  ).trim();
  assert.equal(out, '::error title=undeclared-dependency::x');
});

test('a clean run emits one notice so the log is not silent', () => {
  const checks = [{ pass: true, name: 'npm install <tarball>' }, { pass: true, name: 'import "demo"' }];
  const out = githubAnnotations(result({ checks })).trim();
  assert.equal(out, '::notice title=packproof::demo@1.2.3 installs clean — 2 checks passed, 4 files');
});

test('passing checks never produce annotations of their own', () => {
  const chk = fail({ name: 'x' });
  const out = githubAnnotations(
    result({ ok: false, checks: [{ pass: true, name: 'ok' }, chk], failures: [chk] })
  );
  assert.equal(out.split('\n').filter(Boolean).length, 1);
});

test('githubError: a packproof crash is an annotation too, not silence', () => {
  const { githubError } = FORMATS;
  assert.equal(githubError('no package.json found in /x'), '::error title=packproof::no package.json found in /x\n');
});

test('junit: one testcase per check, failures counted', () => {
  const chk = fail({ name: 'require("ghost") in src/a.js:10', file: 'src/a.js', line: 10, hint: 'add it', detail: 'more' });
  const xml = junitXml(result({ ok: false, checks: [{ pass: true, name: 'npm install <tarball>' }, chk], failures: [chk] }));
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
  assert.match(xml, /<testsuites name="packproof" tests="2" failures="1" errors="0" skipped="0" time="1\.234">/);
  assert.match(xml, /<testsuite name="demo@1\.2\.3" tests="2" failures="1" errors="0" skipped="0" time="1\.234">/);
  assert.match(xml, /<testcase name="npm install &lt;tarball&gt;" classname="demo" \/>/);
  assert.match(xml, /<testcase name="require\(&quot;ghost&quot;\) in src\/a\.js:10" classname="demo" file="src\/a\.js" line="10">/);
  assert.match(xml, /<failure type="undeclared-dependency" message="add it">/);
  assert.match(xml, /\nmore\n\s*<\/failure>/);
  assert.match(xml, /<\/testsuites>\n$/);
});

test('junit: XML-hostile characters are escaped in every position', () => {
  const chk = fail({ name: 'a & <b>', hint: 'say "hi" & <bye>', detail: '1 < 2 & 3 > 2' });
  const xml = junitXml(result({ ok: false, checks: [chk], failures: [chk] }));
  assert.match(xml, /name="a &amp; &lt;b&gt;"/);
  assert.match(xml, /message="say &quot;hi&quot; &amp; &lt;bye&gt;"/);
  assert.match(xml, /1 &lt; 2 &amp; 3 &gt; 2/);
  assert.ok(!/[^&]&[^a-z#]/.test(xml), 'no bare ampersands survive');
});

test('junit: control characters that no XML parser accepts are dropped', () => {
  const chk = fail({ name: 'bell\u0007here', hint: 'tab\tkept' });
  const xml = junitXml(result({ ok: false, checks: [chk], failures: [chk] }));
  assert.match(xml, /name="bellhere"/);
  assert.match(xml, /message="tab\tkept"/);
});

test('junit: a clean run is a suite of passes, not an empty file', () => {
  const xml = junitXml(result({ checks: [{ pass: true, name: 'ok', note: 'fine' }] }));
  assert.match(xml, /tests="1" failures="0" errors="0"/);
  assert.match(xml, /<testcase name="ok" classname="demo" \/>/);
  assert.ok(!xml.includes('<failure'));
});

test('junit: a packproof crash is an <error>, so CI does not read it as green', () => {
  const xml = FORMATS.junitError('no package.json found in /x', 'demo');
  assert.match(xml, /tests="1" failures="0" errors="1"/);
  assert.match(xml, /<error type="packproof" message="no package\.json found in \/x" \/>/);
});

test('the format list is exactly what the CLI accepts', () => {
  assert.deepEqual(FORMATS.names, ['human', 'json', 'github', 'junit']);
});
