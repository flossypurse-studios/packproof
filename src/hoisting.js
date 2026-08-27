// The dependency you never declared, and npm hands you anyway.
//
// npm's default install is *hoisted*: everything in the dependency graph —
// yours, and everything your dependencies dragged in — gets flattened into one
// top-level `node_modules`. So `import "ansi-styles"` resolves inside a clean
// room even when your manifest never mentions ansi-styles, purely because
// chalk brought it along. Node's resolver cannot tell the difference, npm does
// not warn, and every packproof check up to this one passes.
//
// pnpm does not hoist. Yarn PnP does not hoist. npm's own
// `--install-strategy=nested` does not hoist. For a user on any of those, that
// import throws `ERR_MODULE_NOT_FOUND` on the very first line of your package,
// and the bug report reads "works with npm, broken with pnpm" — which is true,
// and is not a pnpm bug.
//
// So: build a second clean room with `--install-strategy=nested`, where nothing
// transitive is reachable by name, and re-import every entry point.
//   - fails on a package this manifest does NOT declare -> a failure
//     (phantom-dependency). It only ever worked by accident.
//   - fails on a package this manifest DOES declare      -> a note, not a
//     verdict: a nested layout is unusual and the fault may be npm's, not
//     the manifest's.
//   - room could not be built, or npm is too old to build one -> say so and
//     pass. An unverified claim is worth less than an admitted gap.

import { execFileSync } from 'node:child_process';
import { createCleanRoom, installTarball, runInRoom } from './cleanroom.js';
import { entrySpecifiers, missingSpecifier } from './checks.js';

/** `--install-strategy` landed in npm 9; before that there is nothing to ask for. */
export const MIN_NPM_MAJOR = 9;

/** Every name this manifest claims as its own, at any dependency strength. */
export function declaredNames(manifest = {}) {
  return new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.peerDependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
    ...(Array.isArray(manifest.bundleDependencies) ? manifest.bundleDependencies : []),
    ...(Array.isArray(manifest.bundledDependencies) ? manifest.bundledDependencies : []),
  ]);
}

/** `@scope/pkg/sub` and `pkg/sub` both belong to a package; find whose. */
function packageRoot(specifier) {
  if (!specifier) return '';
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

/** Whether this npm can be asked for a nested layout at all. */
export function npmSupportsNested(version) {
  const major = Number.parseInt(String(version || '').split('.')[0], 10);
  return Number.isFinite(major) && major >= MIN_NPM_MAJOR;
}

/** Ask npm its version. Returns null when npm cannot be run. */
export function npmVersion() {
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf8', timeout: 30000 }).trim();
  } catch {
    return null;
  }
}

/**
 * The headline check, always emitted when the hoisting check runs — so a report
 * that says nothing about hoisting is a report where the check did not run.
 */
export function hoistingSummaryCheck(depCount) {
  if (!depCount) {
    return {
      name: 'dependency hoisting',
      pass: true,
      note: 'no runtime dependencies, so nothing could have been hoisted into reach that this package did not declare',
    };
  }
  return {
    name: 'dependency hoisting',
    pass: true,
    note:
      `${depCount} runtime ${depCount === 1 ? 'dependency' : 'dependencies'}, whose own dependencies npm flattens ` +
      `into the same node_modules — so this run imports again with that flattening turned off`,
  };
}

/** The check emitted when this npm has no --install-strategy to offer. */
export function nestedUnavailableCheck(version) {
  return {
    name: 'imports under a non-hoisted layout',
    pass: true,
    kind: 'hoisting-unavailable',
    note:
      `npm ${version || 'on this machine'} has no --install-strategy=nested (npm ${MIN_NPM_MAJOR}+ does), so this run ` +
      `never saw what a pnpm-style layout does to these imports. Nothing is claimed about it.`,
  };
}

/** The check emitted when the non-hoisted room could not be built. */
export function hoistRoomFailureCheck(reason) {
  return {
    name: 'imports under a non-hoisted layout',
    pass: true,
    kind: 'hoisting-room-unavailable',
    note:
      'could not install the tarball with --install-strategy=nested, so this run never saw what a pnpm-style ' +
      'layout does to these imports. Nothing is claimed about it.',
    detail: firstLines(reason),
  };
}

/**
 * Classify one non-hoisted import probe.
 *
 * Pure: takes what happened, returns the check (or null to say nothing).
 * `probe` is `{ spec, ok, stderr }`; `declared` is the output of declaredNames().
 */
export function classifyHoistProbe(probe, declared = new Set(), already = new Set()) {
  const name = `import "${probe.spec}" without hoisting`;
  if (probe.ok) return { name, pass: true };

  const missing = missingSpecifier(probe.stderr || '');
  const root = packageRoot(missing || '');
  // Already named by a check that ran in the hoisted room: the same package
  // said twice in different words reads as two problems where there is one.
  if (root && already.has(root)) return null;

  if (root && !declared.has(root)) {
    return {
      name,
      pass: false,
      kind: 'phantom-dependency',
      missing: root,
      hint:
        `"${root}" is imported at load time and is not in this package's dependencies. It resolved a moment ago ` +
        `only because npm flattens your dependencies' dependencies into one node_modules and "${root}" happened ` +
        `to land there. pnpm, Yarn PnP and npm --install-strategy=nested do not do that, so for those users this ` +
        `import throws. Add "${root}" to dependencies — depending on it by accident is depending on it.`,
      detail: firstLines(probe.stderr),
    };
  }
  if (root) {
    return {
      name,
      pass: true,
      note:
        `did not load without hoisting because "${root}" was missing, and "${root}" is a dependency this package ` +
        `does declare — a nested layout, not a manifest that lies. Not counted against you.`,
      detail: firstLines(probe.stderr),
    };
  }
  return {
    name,
    pass: true,
    note:
      'failed to load in the non-hoisted room for a reason packproof could not attribute to a missing package, ' +
      'so it is not counted. Re-run with --keep to look.',
    detail: firstLines(probe.stderr),
  };
}

function firstLines(text, n = 5) {
  return (text || '').split('\n').slice(0, n).join('\n').replace(/\s+$/, '') || undefined;
}

/**
 * Run the hoisting check. Builds and tears down its own clean room, and only
 * when there is something to learn: a package with no runtime dependencies has
 * no hoisting surface at all, and costs one line of report and no install.
 */
export function checkHoisting(tarball, manifest, { keep = false, ignoreScripts = false, already = new Set() } = {}) {
  const deps = Object.keys(manifest.dependencies || {});
  const checks = [hoistingSummaryCheck(deps.length)];
  if (!deps.length) return checks;

  const specs = entrySpecifiers(manifest);
  if (!specs.length) return checks;

  const version = npmVersion();
  if (!npmSupportsNested(version)) {
    checks.push(nestedUnavailableCheck(version));
    return checks;
  }

  const declared = declaredNames(manifest);
  const room = createCleanRoom();
  try {
    const install = installTarball(room, tarball, { ignoreScripts, installStrategy: 'nested' });
    if (!install.ok) {
      checks.push(hoistRoomFailureCheck(install.stderr || install.error));
      return checks;
    }
    for (const spec of specs) {
      const r = runInRoom(room, `await import(${JSON.stringify(spec)});\nconsole.log('ok');\n`);
      const c = classifyHoistProbe({ spec, ok: r.ok, stderr: r.stderr }, declared, already);
      if (c) checks.push(c);
    }
    if (keep) checks[0].detail = `non-hoisted clean room kept at ${room.dir}`;
    return checks;
  } finally {
    if (!keep) room.cleanup();
  }
}
