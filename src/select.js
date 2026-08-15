// Which checks a run is allowed to perform.
//
// A full packproof run does an honest `npm install` of the real tarball into a
// throwaway project, which is the slow part and also the whole point. Some lanes
// want less: a pre-commit hook that only asks "did I just stage a credential",
// a release job that only asks "did a file stop shipping". Those need no install
// at all, and forcing one on them means the check never runs.
//
// So: named check groups, `--only` and `--skip`. The rule that makes this
// tool-shaped instead of foot-gun-shaped is that a run which skipped something
// must SAY so — a green packproof that quietly checked three of eight things is
// exactly the lie this tool exists to prevent. Selection happens here, in one
// pure function with no filesystem and no network, so the honesty is testable.

/** Every check group, in the order a full run performs them. */
export const CHECK_IDS = ['shipped-files', 'diff', 'install', 'entries', 'require', 'bins', 'engines', 'peers', 'lazy'];

/** One line each, for --help and for the site. */
export const CHECK_HELP = {
  'shipped-files': 'the tarball\'s own file list: credentials fail, cruft is noted',
  diff: 'file list against an already-published version (needs --diff)',
  install: 'npm install of the tarball into an empty project',
  entries: 'import every entry point in exports/main/module',
  require: 'require() every entry point too',
  bins: 'execute every declared bin',
  engines: 'import again under the oldest Node engines.node accepts (or --node)',
  peers: 'import again with the declared peerDependencies genuinely absent',
  lazy: 'imports hidden inside functions are declared too (needs --lazy)',
};

/** Nothing can be imported out of a clean room that was never filled. */
export const NEEDS_INSTALL = ['entries', 'require', 'bins', 'engines', 'peers', 'lazy'];

/** Groups that only ever run when their flag was passed. */
const GATED_BY_FLAG = { diff: 'diff', lazy: 'lazy' };

/**
 * A flag that configures a check rather than enabling it: passing it while
 * selecting that check away is the same contradiction, said the other way.
 */
const CONFIGURES_CHECK = { node: 'engines' };

const REASONS = {
  skip: 'skipped with --skip',
  notSelected: 'not selected by --only',
  needsInstall: 'needs the install check, which is not running',
};

/**
 * Split a repeatable, comma-separated option into ids.
 * `--only a,b --only c` and `--only a --only b,c` mean the same thing.
 */
export function parseCheckList(values) {
  const out = [];
  for (const v of [].concat(values || [])) {
    for (const part of String(v ?? '').split(',')) {
      const id = part.trim();
      if (id) out.push(id);
    }
  }
  return out;
}

/** Never guess at a typo: name the real ids, the way --format already does. */
function unknownError(ids, flag) {
  const bad = ids.filter((id) => !CHECK_IDS.includes(id));
  if (!bad.length) return null;
  const plural = bad.length === 1 ? '' : 's';
  return (
    `unknown check${plural} ${bad.map((b) => `"${b}"`).join(', ')} in ${flag} — ` +
    `pick from ${CHECK_IDS.join(', ')}`
  );
}

/**
 * Decide what runs.
 *
 * Returns `{ ok: true, enabled: Set<string>, skipped: [{id, reason}], full: boolean,
 * installed: boolean }`, or `{ ok: false, error }` for a combination packproof
 * refuses rather than resolves. A refusal is always a contradiction the caller
 * wrote down themselves — never a preference of ours.
 */
export function selectChecks({ only, skip, requested = {} } = {}) {
  const onlyIds = parseCheckList(only);
  const skipIds = parseCheckList(skip);

  const bad = unknownError(onlyIds, '--only') || unknownError(skipIds, '--skip');
  if (bad) return { ok: false, error: bad };

  const onlySet = new Set(onlyIds);
  const skipSet = new Set(skipIds);

  const both = CHECK_IDS.filter((id) => onlySet.has(id) && skipSet.has(id));
  if (both.length) {
    return {
      ok: false,
      error:
        `${both.map((id) => `--only ${id} --skip ${id}`).join(' and ')} — ` +
        `asked for and against the same check. Say which one you meant.`,
    };
  }

  // A check whose flag was never passed cannot be the point of --only.
  for (const id of onlyIds) {
    const flag = GATED_BY_FLAG[id];
    if (flag && !requested[flag]) {
      return {
        ok: false,
        error: `--only ${id} but no --${flag} was passed, so the ${id} check has nothing to compare — add --${flag} or drop --only ${id}`,
      };
    }
  }
  const wantsImports = onlyIds.filter((id) => NEEDS_INSTALL.includes(id));
  if (wantsImports.length && skipSet.has('install')) {
    return {
      ok: false,
      error:
        `--only ${wantsImports.join(', ')} needs the package installed, and --skip install removes the install — ` +
        `nothing can be imported out of a clean room that was never filled`,
    };
  }

  // --only a dependent check implies the install: it is a prerequisite, not a
  // preference. --skip install implies skipping everything downstream of it.
  const base = onlySet.size ? new Set(onlyIds) : new Set(CHECK_IDS);
  if (wantsImports.length) base.add('install');
  const removed = new Set(skipSet);
  if (skipSet.has('install')) for (const id of NEEDS_INSTALL) removed.add(id);

  const enabled = new Set(CHECK_IDS.filter((id) => base.has(id) && !removed.has(id)));

  // Switching a flag on and then selecting the check away is a contradiction
  // however it was written — with --skip, or by omission from --only.
  for (const [id, flag] of Object.entries(GATED_BY_FLAG)) {
    if (requested[flag] && !enabled.has(id)) {
      const how = skipSet.has(id) ? `--skip ${id}` : `--only ${onlyIds.join(',')}`;
      return { ok: false, error: `--${flag} asks for the ${id} check and ${how} removes it — pick one` };
    }
  }

  for (const [flag, id] of Object.entries(CONFIGURES_CHECK)) {
    if (!requested[flag] || enabled.has(id)) continue;
    const how = skipSet.has(id)
      ? `--skip ${id}`
      : skipSet.has('install') && NEEDS_INSTALL.includes(id)
        ? '--skip install'
        : `--only ${onlyIds.join(',')}`;
    return {
      ok: false,
      error: `--${flag} names the Node the ${id} check runs under and ${how} removes that check — pick one`,
    };
  }

  if (!enabled.size) {
    return { ok: false, error: `every check was skipped — there is nothing left to prove` };
  }

  const skipped = [];
  for (const id of CHECK_IDS) {
    if (enabled.has(id)) continue;
    let reason = REASONS.notSelected;
    // Say the cause the caller wrote, not a consequence of it: a check they
    // never selected was not "dropped by the install", it was never asked for.
    if (skipSet.has(id)) reason = REASONS.skip;
    else if (base.has(id) && NEEDS_INSTALL.includes(id) && !enabled.has('install')) reason = REASONS.needsInstall;
    skipped.push({ id, reason });
  }

  return {
    ok: true,
    enabled,
    skipped,
    full: skipped.length === 0,
    installed: enabled.has('install'),
  };
}

/**
 * The line a report ends on. `ok` alone is not a verdict once checks were
 * dropped: "this package works when installed" is a claim a run that never
 * installed it has not earned, and must not print.
 */
export function verdictLine(selection, { failures = 0 } = {}) {
  const skipped = (selection && selection.skipped) || [];
  const names = skipped.map((s) => s.id).join(', ');
  const n = skipped.length;
  if (failures > 0) {
    const base = `${failures} problem${failures === 1 ? '' : 's'} your users would hit.`;
    return n ? `${base} ${n} check${n === 1 ? ' was' : 's were'} skipped (${names}).` : base;
  }
  if (!n) return 'this package works when installed.';
  if (!selection.installed) {
    return (
      `everything this run looked at is fine — but it never installed the package, ` +
      `so it proves nothing about installing it. Skipped: ${names}.`
    );
  }
  return `this package works when installed — but ${n} check${n === 1 ? '' : 's'} did not run (${names}), so this is not a full proof.`;
}
