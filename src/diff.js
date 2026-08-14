// What stopped shipping is invisible to every other check in packproof.
//
// A tarball that installs, imports and runs can still be broken for users: a
// template, a .wasm blob, a locale JSON, a whole `dist/` — anything nothing at
// load time reaches — can drop out of the file list when someone edits `files`
// or adds an .npmignore rule, and every probe still passes. The last release is
// the only honest baseline for "what is this package supposed to contain", and
// it is one HTTP request away.
//
// So: fetch the file list of an already-published version and compare it to the
// one about to ship. Two rules, and they follow packproof's existing line
// between a fact and a guess:
//
//   - A path the PREVIOUS release's package.json resolved to (main, module,
//     types, browser, exports, bin) that is gone is a FAILURE. Someone's
//     `import 'pkg/thing'` used to land on a file and now lands on nothing.
//   - Everything else that is gone is NAMED, on a passing check. Deleting an
//     internal file is normal; deciding for you whether you meant it is not
//     packproof's job.
import { tarballFiles } from './pack.js';
import { fetchRegistryTarball, manifestFromTarball, DEFAULT_REGISTRY } from './registry.js';

/** Tarball paths and manifest paths both normalise to "no ./ and no leading /". */
function norm(p) {
  return String(p ?? '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/** Collect every string leaf of an exports/browser subtree. */
function leaves(value, out) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) leaves(v, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) leaves(v, out);
  }
  return out;
}

/**
 * The paths a manifest points at: what an import of this package by name, or by
 * one of its declared subpaths, resolves to.
 *
 * Returned as two lists because npm's `exports` allows a `*` that stands for any
 * substring: `literals` are exact paths, `patterns` are regexes built from those
 * wildcards. Extensionless values (`"main": "index"`) are expanded to the
 * candidates node would actually try, so this over-collects rather than
 * under-collects — a path only counts as dropped if it was in this set AND is
 * gone from the new tarball.
 */
export function manifestEntryPaths(manifest = {}) {
  const raw = [];
  for (const field of ['main', 'module', 'types', 'typings', 'unpkg', 'jsdelivr', 'svelte']) {
    if (typeof manifest[field] === 'string') raw.push(manifest[field]);
  }
  if (manifest.exports !== undefined) leaves(manifest.exports, raw);
  if (manifest.browser !== undefined) leaves(manifest.browser, raw);
  if (typeof manifest.bin === 'string') raw.push(manifest.bin);
  else if (manifest.bin && typeof manifest.bin === 'object') leaves(manifest.bin, raw);

  const literals = new Set();
  const patterns = [];
  for (const value of raw) {
    const p = norm(value);
    if (!p || p.startsWith('#') || /^[a-z]+:/i.test(p)) continue; // an alias or a URL, not a file
    if (p.includes('*')) {
      const rx = p.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      patterns.push(new RegExp(`^${rx}$`));
      continue;
    }
    literals.add(p);
    if (!/\.[a-z0-9]+$/i.test(p)) {
      // Extensionless: node would try these in turn.
      for (const ext of ['.js', '.json', '.node', '.mjs', '.cjs']) literals.add(p + ext);
      for (const ext of ['.js', '.json', '.node', '.mjs', '.cjs']) literals.add(`${p}/index${ext}`);
    }
  }
  return { literals, patterns };
}

/** Was this path something the manifest resolved to? */
export function isDeclaredPath(path, entries) {
  const p = norm(path);
  if (entries.literals.has(p)) return true;
  return entries.patterns.some((rx) => rx.test(p));
}

/**
 * Compare two shipped-file lists. Pure, order-independent, and it never looks at
 * a file's contents — only at whether a path is in one list and not the other.
 */
export function diffFileLists(previous = [], current = []) {
  const before = new Set(previous.map(norm).filter(Boolean));
  const after = new Set(current.map(norm).filter(Boolean));
  const removed = [...before].filter((p) => !after.has(p)).sort();
  const added = [...after].filter((p) => !before.has(p)).sort();
  return {
    added,
    removed,
    kept: [...after].filter((p) => before.has(p)).sort(),
    previousCount: before.size,
    currentCount: after.size,
    identical: added.length === 0 && removed.length === 0,
  };
}

/** `a, b and 3 more`, capped so a wrecked tarball cannot print a thousand lines. */
function listOf(paths, cap = 8) {
  const shown = paths.slice(0, cap);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The `shipped files vs <version>` check.
 *
 * `previousManifest` is the published package.json read out of the published
 * tarball — not the local one — because the question is what the *last release*
 * promised, not what this one does.
 */
export function checkFileDiff({
  previousVersion,
  previousFiles = [],
  previousManifest = {},
  files = [],
  sameVersion = false,
} = {}) {
  const name = `shipped files vs ${previousVersion}`;
  const d = diffFileLists(previousFiles, files);
  const entries = manifestEntryPaths(previousManifest);
  const dropped = d.removed.filter((p) => isDeclaredPath(p, entries));
  const quiet = d.removed.filter((p) => !dropped.includes(p));
  const counts = `${d.previousCount} file${d.previousCount === 1 ? '' : 's'} → ${d.currentCount}`;
  const alsoSame = sameVersion ? ' (the same version: this compares your tree against its own published bytes)' : '';

  // A .d.ts that quietly stops shipping breaks every TypeScript consumer and no
  // probe here can see it: nothing imports it at runtime.
  const typesBefore = [...new Set(previousFiles.map(norm))].filter((p) => /\.d\.[cm]?ts$/.test(p));
  const typesAfter = files.map(norm).filter((p) => /\.d\.[cm]?ts$/.test(p));
  const typesGone = typesBefore.length > 0 && typesAfter.length === 0;

  if (dropped.length || typesGone) {
    const reasons = [];
    if (dropped.length) {
      reasons.push(
        `${plural(dropped.length, 'path')} the published ${previousVersion} package.json pointed at ` +
          `${dropped.length === 1 ? 'is' : 'are'} not in this tarball: ${listOf(dropped)}`
      );
    }
    if (typesGone) {
      reasons.push(
        `${previousVersion} shipped ${plural(typesBefore.length, 'type declaration')} and this tarball ships none: ` +
          listOf(typesBefore)
      );
    }
    const extra = [];
    if (quiet.length) extra.push(`also gone: ${listOf(quiet)}`);
    if (d.added.length) extra.push(`added: ${listOf(d.added)}`);
    return {
      name,
      pass: false,
      kind: typesGone && !dropped.length ? 'dropped-types' : 'dropped-entry-point',
      paths: [...dropped, ...(typesGone ? typesBefore : [])],
      removed: d.removed,
      added: d.added,
      hint:
        `this release stops shipping ${dropped.length || typesGone ? 'something the last one resolved imports to' : 'files'}. ` +
        `Nothing installed here caught it because nothing loads these paths — an import of them just stops working. ` +
        `Check "files" in package.json and your .npmignore, or say plainly in the changelog that this is a breaking change.`,
      detail: [counts, ...reasons, ...extra].join('\n'),
    };
  }

  if (d.identical) {
    return { name, pass: true, removed: [], added: [], note: `identical file list, ${plural(d.currentCount, 'file')}${alsoSame}` };
  }

  const parts = [];
  if (quiet.length) parts.push(`-${quiet.length} gone: ${listOf(quiet)}`);
  if (d.added.length) parts.push(`+${d.added.length} new: ${listOf(d.added)}`);
  return {
    name,
    pass: true,
    removed: d.removed,
    added: d.added,
    note: `${counts}; ${parts.join('; ')}${alsoSame}`,
  };
}

/** `--diff 0.6.0` on package `pkg` means `pkg@0.6.0`; `--diff` alone means latest. */
export function diffSpec(diff, packageName) {
  if (diff === true || diff === undefined || diff === null || diff === '') return `${packageName}@latest`;
  const s = String(diff).trim();
  const at = s.lastIndexOf('@');
  if (at > 0) return s; // already a full spec
  if (s.startsWith('@')) return `${s}@latest`; // a bare scoped name
  return `${packageName}@${s}`;
}

/**
 * Fetch a published version's file list and manifest.
 * Returns `{ unpublished: true }` when the package has never been published —
 * a first release has no baseline, and that is not a failure.
 */
export async function fetchPublishedFiles(spec, { registryUrl = DEFAULT_REGISTRY } = {}) {
  let got;
  try {
    got = await fetchRegistryTarball(spec, { registryUrl });
  } catch (e) {
    if (/no such package/.test(e.message) || /has no published versions/.test(e.message)) {
      return { unpublished: true, error: e.message };
    }
    throw e;
  }
  return {
    version: got.version,
    name: got.name,
    files: tarballFiles(got.tarball),
    manifest: manifestFromTarball(got.tarball),
    bytes: got.bytes,
  };
}

/**
 * The whole `--diff` step: resolve the spec, fetch, compare. Network failures
 * and a version that does not exist are reported as a failed check rather than
 * thrown, so one unreachable registry never hides the rest of the report.
 */
export async function diffAgainstPublished({ manifest = {}, files = [], diff, registryUrl, currentVersion } = {}) {
  const spec = diffSpec(diff, manifest.name);
  let got;
  try {
    got = await fetchPublishedFiles(spec, { registryUrl });
  } catch (e) {
    return {
      check: {
        name: `shipped files vs ${spec}`,
        pass: false,
        kind: 'diff-unavailable',
        hint:
          `packproof could not read the file list of ${spec} to compare against, so it cannot tell you what ` +
          `stopped shipping. Nothing else in this report is affected.`,
        detail: e.message,
      },
      diff: null,
    };
  }
  if (got.unpublished) {
    return {
      check: {
        name: 'shipped files vs published',
        pass: true,
        note: `nothing published under ${manifest.name} yet — a first release has no baseline to compare against`,
      },
      diff: { spec, unpublished: true },
    };
  }
  const check = checkFileDiff({
    previousVersion: `${got.name}@${got.version}`,
    previousFiles: got.files,
    previousManifest: got.manifest,
    files,
    sameVersion: !!currentVersion && currentVersion === got.version,
  });
  return {
    check,
    diff: {
      spec,
      baseline: `${got.name}@${got.version}`,
      version: got.version,
      previousCount: got.files.length,
      currentCount: files.length,
      added: check.added || [],
      removed: check.removed || [],
    },
  };
}
