// A repo's packproof lane, written down once.
//
// packproof grew flags: --only/--skip, --node, --lazy, --strict, --bin-args,
// --ignore-scripts, --format, --diff. A repo that has settled on a lane ends up
// retyping it in every CI job, every README line and every teammate's shell —
// and the day one copy drifts, two of them are lying about what gets proved.
// `packproof.json` lets the repo say it once.
//
// Three rules keep this from becoming the thing packproof exists to prevent:
//
//  1. **A flag always beats the file.** No exceptions, no merging of lists: if
//     you typed --skip on the command line, the file's `skip` is not consulted.
//     The one thing worse than retyping a lane is a flag that silently didn't
//     take.
//  2. **The report says the file was used, and where it came from.** A run whose
//     behaviour came out of a file the reader of the log cannot see is exactly
//     the quiet lie this tool is against.
//  3. **Unknown keys and wrong types are errors**, naming the real keys, the way
//     --only already names the real check ids. A typo'd `"stict": true` that
//     silently does nothing is a green run that proved less than it claimed.
//
// Two deliberate non-features:
//
//  * **No `"packproof"` key in package.json.** package.json is the artifact
//     under test: it ships inside the tarball, so a config key there would be
//     published to every user, and packproof would be reading its own settings
//     out of the very file it is checking. One file, one job.
//  * **No searching parent directories.** packproof.json is read from exactly
//     one place — beside the target's package.json — and nowhere else. A config
//     inherited from three directories up is behaviour the reader cannot see.
//
// This module is pure: no fs, no network. The CLI reads the bytes and hands the
// text here, so every rule above is unit-testable without a filesystem.

import { FORMAT_NAMES } from './format.js';

/** The default filename, looked for beside the target's package.json. */
export const CONFIG_FILENAME = 'packproof.json';

/**
 * Every key a config file may set, and how it is typed.
 *
 * Only settings that are a property of the *repo* live here. Deliberately
 * absent: --registry, --diff <version>, --out, --keep, --workspace and the
 * target itself, which are properties of one invocation — a file that pinned
 * them would make two different jobs claim to have done the same run.
 */
export const CONFIG_KEYS = {
  only: { type: 'list', help: 'run only these checks' },
  skip: { type: 'list', help: 'run everything except these checks' },
  node: { type: 'list', help: 'Node versions or paths the engines check runs under' },
  binArgs: { type: 'args', help: 'args passed to each bin' },
  lazy: { type: 'boolean', help: 'also probe imports hidden inside functions' },
  strict: { type: 'boolean', help: 'fail on everything packproof would only note' },
  ignoreScripts: { type: 'boolean', help: 'install with --ignore-scripts' },
  workspaces: { type: 'boolean', help: 'this repo is a monorepo: prove every package' },
  includePrivate: { type: 'boolean', help: 'do not skip private workspace packages' },
  diff: { type: 'boolean', help: 'compare the file list against the published latest' },
  format: { type: 'enum', values: FORMAT_NAMES, help: 'human, json, github or junit' },
  registryUrl: { type: 'string', help: 'registry to ask' },
};

const KEY_NAMES = Object.keys(CONFIG_KEYS);

/** `bin-args`, `BINARGS` and `bin_args` all mean `binArgs` — to a human. Say so. */
function didYouMean(key) {
  const flat = String(key).toLowerCase().replace(/[-_\s]/g, '');
  return KEY_NAMES.find((k) => k.toLowerCase() === flat) || null;
}

function typeName(spec) {
  if (spec.type === 'boolean') return 'true or false';
  if (spec.type === 'list' || spec.type === 'args') return 'a string or an array of strings';
  if (spec.type === 'enum') return spec.values.map((v) => `"${v}"`).join(', ');
  return 'a string';
}

function show(value) {
  return typeof value === 'string' ? `"${value}"` : Array.isArray(value) ? 'an array' : JSON.stringify(value);
}

/**
 * Normalise one value, or explain why it cannot be.
 *
 * A string is accepted wherever a list is: `"only": "entries"` and
 * `"only": ["entries"]` mean the same thing, because the flag spelling
 * (`--only entries`) is a string and nobody should have to remember which side
 * of the line they are on. `binArgs` as a string splits on spaces, exactly the
 * way `--bin-args "--version --json"` does.
 */
function normalise(key, value, spec) {
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') return { error: `"${key}" must be ${typeName(spec)}, got ${show(value)}` };
    return { value };
  }
  if (spec.type === 'string' || spec.type === 'enum') {
    if (typeof value !== 'string') return { error: `"${key}" must be ${spec.type === 'enum' ? 'one of ' + typeName(spec) : 'a string'}, got ${show(value)}` };
    if (spec.type === 'enum' && !spec.values.includes(value)) {
      return { error: `"${key}" is "${value}" — pick one of ${spec.values.join(', ')}` };
    }
    return { value };
  }
  // list / args
  const raw = Array.isArray(value) ? value : [value];
  if (!raw.length) return { error: `"${key}" is empty — remove it, or say what you meant` };
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { error: `"${key}" must be ${typeName(spec)}, got ${show(value)}` };
    if (spec.type === 'args') {
      for (const part of item.split(' ')) if (part) out.push(part);
    } else {
      const trimmed = item.trim();
      if (!trimmed) return { error: `"${key}" contains an empty entry — remove it, or say what you meant` };
      out.push(trimmed);
    }
  }
  if (!out.length) return { error: `"${key}" is empty — remove it, or say what you meant` };
  return { value: out };
}

/**
 * Parse the text of a config file.
 *
 * Returns `{ ok: true, config }` with normalised values, or `{ ok: false, error }`
 * — never a partially applied config, and never a silently dropped key. `source`
 * is the name to blame in the error, e.g. `packproof.json`.
 */
export function parseConfig(text, { source = CONFIG_FILENAME } = {}) {
  const where = (msg) => ({ ok: false, error: `${source}: ${msg}` });
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return where(`not valid JSON — ${e.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return where(`expected a JSON object, got ${Array.isArray(data) ? 'an array' : JSON.stringify(data)}`);
  }

  const config = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === '$schema' || key === '//') continue; // editor plumbing and comments, not settings
    const spec = CONFIG_KEYS[key];
    if (!spec) {
      const near = didYouMean(key);
      return where(
        `unknown key "${key}"${near ? ` — did you mean "${near}"?` : ''}` +
          (near ? '' : ` — pick from ${KEY_NAMES.join(', ')}`)
      );
    }
    const got = normalise(key, value, spec);
    if (got.error) return where(got.error);
    config[key] = got.value;
  }
  return { ok: true, config };
}

/**
 * Fold a parsed config into the options a command line produced.
 *
 * `provided` is the set of option names the user actually typed. A key in there
 * wins outright — no list concatenation, no per-element merge, because a --skip
 * that turned out to be "--skip plus whatever the file said" is a flag that did
 * not do what it looked like it did.
 *
 * Returns `{ opts, applied, overridden }`: `applied` is what the file actually
 * changed (in key order), `overridden` is what it tried to change and a flag
 * beat. Both go into the report — see `configSummary`.
 */
export function mergeConfig(config, opts = {}, provided = new Set()) {
  const has = provided instanceof Set ? (k) => provided.has(k) : (k) => !!(provided && provided[k]);
  const merged = { ...opts };
  const applied = [];
  const overridden = [];
  for (const key of KEY_NAMES) {
    if (!(key in (config || {}))) continue;
    if (has(key)) {
      overridden.push(key);
      continue;
    }
    merged[key] = config[key];
    applied.push({ key, value: config[key] });
  }
  return { opts: merged, applied, overridden };
}

/** `skip=install`, `lazy=true`, `node=18,20` — short enough for one report line. */
function showValue(value) {
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

/**
 * The one line a run prints when a config file was involved.
 *
 * Not optional and not verbose: a reader of the log has to be able to see that
 * behaviour came from a file, which file, and what it said. Returns null when no
 * config was loaded, so a run without one is byte-identical to every earlier
 * version of packproof.
 */
export function configSummary(loaded) {
  if (!loaded || !loaded.path) return null;
  const applied = loaded.applied || [];
  const overridden = loaded.overridden || [];
  const head = `config — ${loaded.path}`;
  const tail = overridden.length ? ` (flags override ${overridden.join(', ')})` : '';
  if (!applied.length) {
    if (overridden.length) return `${head}: every setting overridden by flags (${overridden.join(', ')})`;
    return `${head}: no settings`;
  }
  return `${head}: ${applied.map(({ key, value }) => `${key}=${showValue(value)}`).join(', ')}${tail}`;
}
