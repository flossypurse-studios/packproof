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

/** GitHub Actions workflow commands: one physical line per annotation. */
export function githubAnnotations(result) {
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
  if (!lines.length) {
    const passed = (result.checks || []).length;
    lines.push(
      `::notice title=packproof::${escapeData(
        `${result.name}@${result.version} installs clean — ${passed} check${passed === 1 ? '' : 's'} passed, ${result.fileCount} files`
      )}`
    );
  }
  return lines.join('\n') + '\n';
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

/** JUnit XML: one testcase per check, one <failure> per problem. */
export function junitXml(result) {
  const checks = result.checks || [];
  const failures = checks.filter((c) => !c.pass).length;
  const time = seconds(result.durationMs);
  const suiteName = `${result.name}@${result.version}`;
  const counts = `tests="${checks.length}" failures="${failures}" errors="0" time="${time}"`;
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="packproof" ${counts}>`,
    `  <testsuite name="${xml(suiteName)}" ${counts}>`,
  ];
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
  out.push('  </testsuite>', '</testsuites>', '');
  return out.join('\n');
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

export const FORMATS = { names: FORMAT_NAMES, githubAnnotations, githubError, junitXml, junitError };
