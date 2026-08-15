// CI-shaped output. A failure that scrolls past in a log costs the same as no
// failure at all, so packproof can also speak the two dialects CI reads: GitHub
// Actions workflow commands, which put the error on the offending line of the
// diff, and JUnit XML, which almost every other runner ingests.
//
// The default human output is not produced here and is not touched by anything
// here — it stays byte-identical.

export const FORMAT_NAMES = ['human', 'json', 'github', 'junit'];

/**
 * Escape a value used as annotation *data* (the message after `::`).
 * Percent first, or an escape sequence we just wrote gets escaped again.
 */
export function escapeData(s) {
  return String(s ?? '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

/**
 * Escape a value used as an annotation *property* (`file=`, `title=`, ...).
 * Properties are comma-separated and colon-terminated, so those go too.
 */
export function escapeProp(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** The message body of an annotation: what failed, then how to fix it. */
function annotationMessage(chk) {
  return [chk.name, chk.hint, chk.detail].filter(Boolean).join('\n');
}

/**
 * The path to blame in the workspace, or null when we cannot honestly name one.
 * Only a local run has a checkout the shipped file paths line up with: in
 * --registry mode the bytes came from the registry and may match nothing on disk.
 */
function workspacePath(result, chk) {
  if (!chk.file) return null;
  if (result.source && result.source !== 'local') return null;
  const prefix = (result.pathPrefix || '').replace(/\/+$/, '');
  if (!prefix || prefix === '.') return chk.file;
  return `${prefix}/${chk.file}`;
}

/**
 * The runs a report covers: one for a single package, one per package for a
 * workspace run. Each carries its own pathPrefix, so a formatter that iterates
 * these keeps pointing at the right file in the checkout.
 */
export function runsOf(result) {
  return Array.isArray(result && result.packages) ? result.packages : [result];
}

/** GitHub Actions workflow commands: one physical line per annotation. */
export function githubAnnotations(result) {
  const lines = [];
  for (const run of runsOf(result)) lines.push(...githubLines(run));
  if (!lines.length) lines.push(githubCleanNotice(result));
  // A run that dropped checks says so whether or not anything failed: a log
  // showing only green annotations must never imply a full proof.
  const notice = githubSkippedNotice(result);
  if (notice) lines.push(notice);
  // A run configured by a file says so here too: a log that shows only the
  // outcome, and not that a file chose what was checked, is half a report.
  const config = configNotice(result);
  if (config) lines.push(config);
  return lines.join('\n') + '\n';
}

/** What did not run, and — when it matters most — that nothing was installed. */
export function skippedOf(result) {
  const seen = new Map();
  for (const run of runsOf(result)) for (const sk of run.skippedChecks || []) seen.set(sk.id, sk);
  for (const sk of (result && result.skippedChecks) || []) seen.set(sk.id, sk);
  return [...seen.values()];
}

function githubSkippedNotice(result) {
  const skipped = skippedOf(result);
  if (!skipped.length) return null;
  const names = skipped.map((sk) => sk.id).join(', ');
  const installed = runsOf(result).every((r) => r.installed !== false) && result.installed !== false;
  const tail = installed
    ? 'this is not a full proof.'
    : 'the package was never installed, so this run proves nothing about installing it.';
  return `::notice title=packproof::${escapeData(
    `${skipped.length} check${skipped.length === 1 ? '' : 's'} did not run (${names}) — ${tail}`
  )}`;
}

function githubLines(result) {
  const lines = [];
  for (const chk of result.checks || []) {
    if (chk.pass) continue;
    const props = [];
    const file = workspacePath(result, chk);
    if (file) {
      props.push(`file=${escapeProp(file)}`);
      if (Number.isInteger(chk.line)) props.push(`line=${chk.line}`);
    }
    props.push(`title=${escapeProp(chk.kind || 'packproof')}`);
    lines.push(`::error ${props.join(',')}::${escapeData(annotationMessage(chk))}`);
  }
  return lines;
}

/** Nothing failed. Say so once, so the step is never silently empty. */
function githubCleanNotice(result) {
  const runs = runsOf(result);
  const passed = runs.reduce((n, r) => n + (r.checks || []).length, 0);
  const files = runs.reduce((n, r) => n + (r.fileCount || 0), 0);
  // "installs clean" is a claim only a run that installed it may make.
  const installed = runs.every((r) => r.installed !== false);
  const subject = result.packages
    ? `${runs.length} package${runs.length === 1 ? '' : 's'} in ${result.rootName || 'this workspace'}` +
      (installed ? ` install${runs.length === 1 ? 's' : ''}` : '')
    : `${result.name}@${result.version}${installed ? ' installs' : ''}`;
  return `::notice title=packproof::${escapeData(
    `${subject} clean — ${passed} check${passed === 1 ? '' : 's'} passed, ${files} files`
  )}`;
}

/**
 * The one-line summary of the config file this run used, if it used one. The
 * CLI renders it (src/config.js owns the wording) and puts it in the result, so
 * every format shows the reader the same sentence.
 */
export function configSummaryOf(result) {
  const runs = runsOf(result);
  const from = (result && result.config) || runs.map((r) => r.config).find(Boolean);
  return (from && from.summary) || null;
}

function configNotice(result) {
  const summary = configSummaryOf(result);
  return summary ? `::notice title=packproof::${escapeData(summary)}` : null;
}

/** A packproof error (exit 2) still has to be visible in the log. */
export function githubError(message) {
  return `::error title=packproof::${escapeData(message)}\n`;
}

const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function xml(s) {
  return String(s ?? '')
    .replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function seconds(ms) {
  return (Number(ms || 0) / 1000).toFixed(3);
}

/**
 * JUnit XML: one testcase per check, one <failure> per problem, and — for a
 * workspace run — one <testsuite> per package inside the same <testsuites>.
 */
export function junitXml(result) {
  const runs = runsOf(result);
  const total = runs.reduce((n, r) => n + (r.checks || []).length + (r.skippedChecks || []).length, 0);
  const failed = runs.reduce((n, r) => n + (r.checks || []).filter((c) => !c.pass).length, 0);
  const skipped = runs.reduce((n, r) => n + (r.skippedChecks || []).length, 0);
  const counts = `tests="${total}" failures="${failed}" errors="0" skipped="${skipped}" time="${seconds(
    result.durationMs
  )}"`;
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="packproof" ${counts}>`];
  const summary = configSummaryOf(result);
  if (summary) {
    out.push('  <properties>', `    <property name="packproof.config" value="${xml(summary)}" />`, '  </properties>');
  }
  for (const run of runs) out.push(...junitSuite(run));
  out.push('</testsuites>', '');
  return out.join('\n');
}

function junitSuite(result) {
  const checks = result.checks || [];
  const missing = result.skippedChecks || [];
  const failures = checks.filter((c) => !c.pass).length;
  const time = seconds(result.durationMs);
  const suiteName = `${result.name}@${result.version}`;
  const counts =
    `tests="${checks.length + missing.length}" failures="${failures}" errors="0" ` +
    `skipped="${missing.length}" time="${time}"`;
  const out = [`  <testsuite name="${xml(suiteName)}" ${counts}>`];
  for (const chk of checks) {
    const attrs = [`name="${xml(chk.name)}"`, `classname="${xml(result.name)}"`];
    const file = workspacePath(result, chk);
    if (file) {
      attrs.push(`file="${xml(file)}"`);
      if (Number.isInteger(chk.line)) attrs.push(`line="${chk.line}"`);
    }
    if (chk.pass) {
      out.push(`    <testcase ${attrs.join(' ')} />`);
      continue;
    }
    out.push(`    <testcase ${attrs.join(' ')}>`);
    out.push(
      `      <failure type="${xml(chk.kind || 'packproof')}" message="${xml(chk.hint || chk.name)}">`
    );
    const body = [chk.name, chk.hint, chk.detail].filter(Boolean).join('\n');
    out.push(xml(body));
    out.push('      </failure>');
    out.push('    </testcase>');
  }
  // A check that did not run is a skipped testcase, not an absent one: a CI
  // dashboard should show the hole rather than a shorter green bar.
  for (const sk of missing) {
    out.push(`    <testcase name="${xml(sk.id)}" classname="${xml(result.name)}">`);
    out.push(`      <skipped message="${xml(sk.reason)}" />`);
    out.push('    </testcase>');
  }
  out.push('  </testsuite>');
  return out;
}

/** A packproof error as a JUnit report, so CI cannot read a crash as green. */
export function junitError(message, name = 'packproof') {
  const counts = 'tests="1" failures="0" errors="1" time="0.000"';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="packproof" ${counts}>`,
    `  <testsuite name="${xml(name)}" ${counts}>`,
    `    <testcase name="packproof" classname="${xml(name)}">`,
    `      <error type="packproof" message="${xml(message)}" />`,
    '    </testcase>',
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

export const FORMATS = { names: FORMAT_NAMES, githubAnnotations, githubError, junitXml, junitError, runsOf, skippedOf, configSummaryOf };
