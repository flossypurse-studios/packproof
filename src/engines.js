// A package.json that says `"engines": { "node": ">=18" }` is a promise, and
// nothing in the npm toolchain ever checks it. `npm install` prints a warning at
// most; your CI runs one Node version, usually the newest; and the first person
// to find out that your "Node 18 supported" package uses a Node 20 builtin is a
// stranger on Node 18.
//
// packproof already has the package installed in a clean room, so it can import
// it again under the oldest Node the manifest claims — if such a Node exists on
// this machine. When one does not, the check says so in those words rather than
// passing quietly, because a green line that verified nothing is worse than no
// line at all. Everything here except `discoverInterpreters` and `checkEngines`
// is pure, so the classification can be tested without a second Node.

import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runInRoom } from './cleanroom.js';
import { entrySpecifiers, firstLines } from './checks.js';

/** Parse "v18.20.4" / "18.2" / "18" into {major,minor,patch}. Null if it is not a version. */
export function parseVersion(str) {
  const m = String(str ?? '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}

/** Order two parsed versions. */
export function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function formatVersion(v) {
  return v ? `${v.major}.${v.minor}.${v.patch}` : null;
}

const ANY = { lo: null, hi: null };

/** How many version parts the author actually wrote: "18" is 1, "18.2.0" is 3. */
function partsOf(str) {
  const m = String(str).trim().match(/^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/);
  if (!m) return 0;
  if (m[2] === undefined || /[xX*]/.test(m[2])) return 1;
  if (m[3] === undefined || /[xX*]/.test(m[3])) return 2;
  return 3;
}

/** A bare/partial version behaves like a range: "18" means >=18.0.0 <19.0.0. */
function fromPartial(str) {
  const v = parseVersion(String(str).replace(/\.[xX*]/g, '.0'));
  if (!v) return null;
  const parts = partsOf(str);
  if (parts >= 3) return { lo: { v, inclusive: true }, hi: { v, inclusive: true } };
  if (parts === 2) return { lo: { v, inclusive: true }, hi: { v: { ...v, minor: v.minor + 1, patch: 0 }, inclusive: false } };
  return { lo: { v, inclusive: true }, hi: { v: { major: v.major + 1, minor: 0, patch: 0 }, inclusive: false } };
}

/** One comparator ("^18", ">=16.1", "<21") as a low/high interval. Null = unreadable. */
function comparator(token) {
  const t = token.trim();
  if (!t || t === '*' || t === 'x' || t === 'X') return ANY;
  const m = t.match(/^(>=|<=|>|<|=|\^|~>|~)?\s*(v?\d[^\s]*|[xX*])$/);
  if (!m) return null;
  const [, op, raw] = m;
  if (raw === '*' || raw === 'x' || raw === 'X') return ANY;
  const partial = fromPartial(raw);
  if (!partial) return null;
  const v = partial.lo.v;
  switch (op) {
    case '>=':
      return { lo: { v, inclusive: true }, hi: null };
    case '>':
      // ">18" excludes all of 18.x, the same way npm's semver reads it.
      return partsOf(raw) >= 3
        ? { lo: { v, inclusive: false }, hi: null }
        : { lo: { v: partial.hi.v, inclusive: true }, hi: null };
    case '<=':
      return { lo: null, hi: { v: partial.hi && partsOf(raw) < 3 ? partial.hi.v : v, inclusive: partsOf(raw) >= 3 } };
    case '<':
      return { lo: null, hi: { v, inclusive: false } };
    case '^': {
      const hi =
        v.major > 0
          ? { major: v.major + 1, minor: 0, patch: 0 }
          : v.minor > 0
            ? { major: 0, minor: v.minor + 1, patch: 0 }
            : { major: 0, minor: 0, patch: v.patch + 1 };
      return { lo: { v, inclusive: true }, hi: { v: hi, inclusive: false } };
    }
    case '~':
    case '~>':
      return {
        lo: { v, inclusive: true },
        hi: { v: partsOf(raw) === 1 ? { major: v.major + 1, minor: 0, patch: 0 } : { major: v.major, minor: v.minor + 1, patch: 0 }, inclusive: false },
      };
    case '=':
      return partsOf(raw) >= 3 ? { lo: { v, inclusive: true }, hi: { v, inclusive: true } } : partial;
    default:
      return partial;
  }
}

/** Intersect a whitespace-separated comparator set into one interval. Null = unreadable. */
function intersect(tokens) {
  let lo = null;
  let hi = null;
  for (const tok of tokens) {
    const c = comparator(tok);
    if (!c) return null;
    if (c.lo && (!lo || compareVersions(c.lo.v, lo.v) > 0 || (compareVersions(c.lo.v, lo.v) === 0 && !c.lo.inclusive)))
      lo = c.lo;
    if (c.hi && (!hi || compareVersions(c.hi.v, hi.v) < 0 || (compareVersions(c.hi.v, hi.v) === 0 && !c.hi.inclusive)))
      hi = c.hi;
  }
  return { lo, hi };
}

/**
 * Read an engines.node range into a union of intervals.
 * `readable: false` means packproof does not understand it and will say so
 * rather than guess — the same rule the rest of the tool follows.
 */
export function parseRange(range) {
  const raw = String(range ?? '').trim();
  if (!raw) return { readable: true, any: true, sets: [ANY] };
  const sets = [];
  for (const alt of raw.split('||')) {
    const tokens = alt.trim().split(/\s+/).filter(Boolean);
    // "18 - 20": a hyphen range, whose floor is the left-hand side.
    const dash = tokens.indexOf('-');
    if (dash === 1 && tokens.length === 3) {
      const left = fromPartial(tokens[0]);
      const right = fromPartial(tokens[2]);
      if (!left || !right) return { readable: false, any: false, sets: [] };
      sets.push({ lo: left.lo, hi: { v: right.hi ? right.hi.v : right.lo.v, inclusive: partsOf(tokens[2]) >= 3 } });
      continue;
    }
    const set = intersect(tokens.length ? tokens : ['*']);
    if (!set) return { readable: false, any: false, sets: [] };
    sets.push(set);
  }
  const any = sets.some((s) => !s.lo && !s.hi);
  return { readable: true, any, sets };
}

/** Does this version satisfy the range? Unreadable ranges answer null, never a guess. */
export function satisfiesRange(version, parsed) {
  if (!parsed.readable) return null;
  return parsed.sets.some((s) => {
    if (s.lo) {
      const cmp = compareVersions(version, s.lo.v);
      if (cmp < 0 || (cmp === 0 && !s.lo.inclusive)) return false;
    }
    if (s.hi) {
      const cmp = compareVersions(version, s.hi.v);
      if (cmp > 0 || (cmp === 0 && !s.hi.inclusive)) return false;
    }
    return true;
  });
}

/** The lowest Node the range claims to support — the part of the promise most likely to be a lie. */
export function floorOf(parsed) {
  if (!parsed.readable || parsed.any) return null;
  let floor = null;
  for (const s of parsed.sets) {
    if (!s.lo) return null; // one alternative accepts anything downwards
    if (!floor || compareVersions(s.lo.v, floor) < 0) floor = s.lo.v;
  }
  return floor;
}

/**
 * Which installed Node to re-import under: the lowest one the range accepts.
 * Returns null when nothing installed here satisfies the range at all.
 */
export function chooseInterpreter(interpreters, parsed, floor) {
  const ok = interpreters
    .filter((i) => i.version && satisfiesRange(i.version, parsed))
    .sort((a, b) => compareVersions(a.version, b.version));
  if (!ok.length) return null;
  const chosen = ok[0];
  return {
    ...chosen,
    // Only a Node of the floor's own major actually tests the claim's weakest edge.
    atFloor: Boolean(floor && chosen.version.major === floor.major),
  };
}

const VERSION_DIR = /^v?\d+\.\d+\.\d+/;

/** Well-known places a second Node lives. Layout differs per version manager. */
function candidateRoots(env, home) {
  return [
    { dir: env.NVM_DIR ? join(env.NVM_DIR, 'versions', 'node') : join(home, '.nvm', 'versions', 'node'), bin: ['bin', 'node'] },
    { dir: join(home, '.local', 'share', 'fnm', 'node-versions'), bin: ['installation', 'bin', 'node'] },
    { dir: join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), bin: ['installation', 'bin', 'node'] },
    { dir: join(env.N_PREFIX || '/usr/local', 'n', 'versions', 'node'), bin: ['bin', 'node'] },
    { dir: join(home, '.volta', 'tools', 'image', 'node'), bin: ['bin', 'node'] },
    { dir: join(home, '.asdf', 'installs', 'nodejs'), bin: ['bin', 'node'] },
  ];
}

/**
 * Every Node on this machine packproof could re-run the import under, including
 * the one it is running as. Version comes from the directory name, so this costs
 * no processes; the chosen one is confirmed by actually running it.
 */
export function discoverInterpreters({ env = process.env, home = homedir(), execPath = process.execPath, running = process.version } = {}) {
  const found = [{ path: execPath, version: parseVersion(running), running: true }];
  const seen = new Set([formatVersion(found[0].version)]);
  for (const root of candidateRoots(env, home)) {
    let names;
    try {
      names = readdirSync(root.dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!VERSION_DIR.test(name)) continue;
      const version = parseVersion(name);
      const key = formatVersion(version);
      if (!version || seen.has(key)) continue;
      const path = join(root.dir, name, ...root.bin);
      if (!existsSync(path)) continue;
      seen.add(key);
      found.push({ path, version, running: false });
    }
  }
  return found;
}

/**
 * Why an import that works on the current Node failed on an older one. Naming
 * the reason is the difference between "your package is broken somewhere" and
 * "you used a builtin that does not exist there".
 */
export function whyUnsatisfied(stderr) {
  const s = String(stderr || '');
  if (/ERR_UNKNOWN_BUILTIN_MODULE|No such built-in module|Cannot find module 'node:/.test(s))
    return 'it imports a builtin module that Node version does not have';
  if (/SyntaxError/.test(s)) return 'that Node version cannot parse the syntax it ships';
  if (/ERR_REQUIRE_ESM|require\(\) of ES Module/.test(s))
    return 'that Node version cannot require() the ES module it ships';
  if (/is not a function|is not a constructor|undefined \(reading/.test(s))
    return 'it calls an API that Node version does not have';
  if (/ERR_UNSUPPORTED_[A-Z_]+|Unsupported/.test(s)) return 'that Node version rejects something the package does';
  return null;
}

/**
 * Build the check. Pure: the caller does the running and hands the result in,
 * so every branch of the verdict is testable with no second Node anywhere.
 *
 * `probe` is `{ ok, stderr, specifier }` or null when nothing was run.
 */
export function classifyEngines({ range, interpreters = [], probe = null, running = null } = {}) {
  const name = `engines.node "${range}"`;
  const parsed = parseRange(range);
  const runningV = parseVersion(running);
  const runningLabel = runningV ? `node v${formatVersion(runningV)}` : 'the node running packproof';

  if (!parsed.readable) {
    return {
      name,
      pass: true,
      kind: 'engines-unverified',
      note: `packproof does not understand this range, so it did not verify it — everything else here ran under ${runningLabel}`,
    };
  }
  if (parsed.any) {
    return { name, pass: true, note: `accepts any version, so there is nothing to verify — this run used ${runningLabel}` };
  }

  const floor = floorOf(parsed);
  const floorLabel = floor ? `node ${floor.major}` : 'the lowest version it claims';
  const chosen = chooseInterpreter(interpreters, parsed, floor);

  if (!chosen) {
    const runningInRange = runningV ? satisfiesRange(runningV, parsed) : null;
    return {
      name,
      pass: true,
      kind: 'engines-unverified',
      note:
        `no node this range accepts is installed here, so packproof did not verify the claim` +
        (runningInRange === false ? ` — even ${runningLabel}, which ran everything else in this report, is excluded by it` : ` — everything else here ran under ${runningLabel}`),
    };
  }

  const underLabel = `node v${formatVersion(chosen.version)}`;

  if (probe && probe.ok === false) {
    const why = whyUnsatisfied(probe.stderr);
    return {
      name,
      pass: false,
      kind: 'engines-unsatisfied',
      hint:
        `this package says it runs on ${floorLabel} and up, but importing ` +
        `${probe.specifier ? `"${probe.specifier}"` : 'it'} under ${underLabel} fails` +
        (why ? `: ${why}. ` : '. ') +
        `Either raise engines.node to a version that works, or stop using what does not exist down there. ` +
        `Anyone on ${underLabel} installs this and it does not load.`,
      detail: firstLines(probe.stderr),
      node: formatVersion(chosen.version),
    };
  }

  if (!probe) {
    return {
      name,
      pass: true,
      kind: 'engines-unverified',
      note: `nothing to import, so the claim was not verified — this run used ${runningLabel}`,
    };
  }

  if (chosen.atFloor) {
    return {
      name,
      pass: true,
      note: chosen.running
        ? `imported under ${underLabel}, which is the oldest version this range claims`
        : `imported under ${underLabel}, the oldest node here that this range claims`,
      node: formatVersion(chosen.version),
    };
  }
  return {
    name,
    pass: true,
    kind: 'engines-partly-verified',
    note:
      `imported under ${underLabel}, the oldest node installed here that this range accepts — ` +
      `no ${floorLabel} on this machine, so the floor itself is still unverified`,
    node: formatVersion(chosen.version),
  };
}

// ---------------------------------------------------------------------------
// --node: the escape hatch.
//
// Everything above can only verify a floor that happens to be installed. On a
// box with one Node 22, a package claiming ">=18" gets an honest shrug. `--node`
// closes that gap by letting the caller name the interpreter: a path to a node
// binary, or a bare version matched against the ones already discovered. It is
// resolved before anything is packed, and an unusable value is an error with a
// real message — the same contract `--only` has with an unknown check id.

/** Which kind of thing a `--node` value is. Pure; the runner does the spawning. */
export function classifyNodeRequest(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { kind: 'empty', raw };
  if (/^v?\d+(\.\d+){0,2}$/.test(raw)) return { kind: 'version', raw, version: parseVersion(raw), parts: partsOf(raw) };
  return { kind: 'path', raw };
}

/** Does a discovered interpreter answer to the version the caller wrote? */
function versionMatches(candidate, req) {
  if (!candidate) return false;
  if (candidate.major !== req.version.major) return false;
  if (req.parts >= 2 && candidate.minor !== req.version.minor) return false;
  if (req.parts >= 3 && candidate.patch !== req.version.patch) return false;
  return true;
}

/**
 * Turn `--node` values into interpreters to run under.
 *
 * Pure: `probed` is a Map of path -> { ok, output, version } the caller filled
 * by actually running each path, so every refusal is testable without a second
 * Node existing anywhere. Returns `{ ok, nodes }` or `{ ok: false, error }`.
 */
export function resolveNodeRequests(requests, { interpreters = [], probed = new Map() } = {}) {
  const known = interpreters.filter((i) => i.version).sort((a, b) => compareVersions(a.version, b.version));
  const nodes = [];
  const seen = new Set();
  for (const req of [].concat(requests || [])) {
    let node;
    if (req.kind === 'empty') {
      return {
        ok: false,
        error: '--node needs a value: a path to a node binary, or a version like 18 or 18.20.4',
      };
    }
    if (req.kind === 'version') {
      const match = known.find((i) => versionMatches(i.version, req));
      if (!match) {
        const list = known.length ? known.map((i) => formatVersion(i.version)).join(', ') : 'none';
        return {
          ok: false,
          error:
            `--node ${req.raw}: no node ${req.raw} is installed where packproof looks (nvm, fnm, n, volta, asdf, ` +
            `and the node running packproof) — it found ${list}. Point --node at the binary instead: --node /path/to/node`,
        };
      }
      node = { path: match.path, version: match.version, requested: req.raw, running: !!match.running };
    } else {
      const got = probed.get(req.raw);
      if (!got || !got.ok) {
        return {
          ok: false,
          error: `--node ${req.raw}: packproof could not run it (${(got && got.error) || 'no such file'}) — --node takes a path to a node binary, or a version like 18`,
        };
      }
      if (!got.version) {
        return {
          ok: false,
          error:
            `--node ${req.raw}: it ran, but \`${req.raw} --version\` printed ${JSON.stringify(String(got.output || '').replace(/\s+/g, ' ').trim().slice(0, 60))}, ` +
            `which is not a node version — is that a node binary?`,
        };
      }
      node = { path: req.raw, version: got.version, requested: req.raw, running: false };
    }
    // The same interpreter named twice (as a path and as a version, say) is one
    // run, not two: re-importing under it a second time proves nothing new.
    const key = `${node.path}@${formatVersion(node.version)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push(node);
  }
  return { ok: true, nodes };
}

/** Ask a binary what it is. The impure half of resolving a `--node` path. */
export function nodeVersionOf(path, { timeout = 10000 } = {}) {
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout });
  if (r.error) return { ok: false, error: r.error.code || r.error.message };
  if (r.status !== 0) return { ok: false, error: `it exited ${r.status}` };
  const output = String(r.stdout || '').trim();
  return { ok: true, output, version: /^v\d+\.\d+\.\d+/.test(output) ? parseVersion(output) : null };
}

/** Resolve `--node` values for real: discover, probe the paths, then classify. */
export function resolveNodes(values, { interpreters } = {}) {
  const requests = [].concat(values || []).map(classifyNodeRequest);
  const probed = new Map();
  for (const req of requests) {
    if (req.kind === 'path' && !probed.has(req.raw)) probed.set(req.raw, nodeVersionOf(req.raw));
  }
  return resolveNodeRequests(requests, { interpreters: interpreters || discoverInterpreters(), probed });
}

/**
 * The verdict for one Node the caller named. Pure, like `classifyEngines`.
 *
 * The interesting case is a Node the declared range does NOT accept. Both ways
 * it can go are reported, and neither is a failure of the package:
 *   - it imports fine there  -> pass, and say the floor may be higher than needed;
 *   - it fails there         -> pass, and say plainly that it failed, and that
 *                               engines.node already excludes that Node.
 * Failing the run would mean blaming a package for not keeping a promise it
 * never made — `--node 16` against `">=18"` is a question, not an accusation.
 * The line still says exactly what happened, so nothing is passed quietly.
 *
 * With NO engines.node at all there is no promise to shelter behind: npm will
 * install this on the Node you asked about, so a failed import there is a real
 * failure, and the report says the manifest is silent about it.
 */
export function classifyRequestedNode({ range = null, node, probe = null } = {}) {
  const under = `node v${formatVersion(node.version)}`;
  const declared = range !== null && range !== undefined && String(range).trim() !== '';
  const parsed = declared ? parseRange(range) : null;
  const inRange = parsed && parsed.readable ? satisfiesRange(node.version, parsed) : null;
  const floor = parsed ? floorOf(parsed) : null;
  const atFloor = Boolean(floor && node.version.major === floor.major);
  const name = declared ? `engines.node "${range}" on ${under}` : `${under}, which nothing declares`;
  const asked = node.requested === formatVersion(node.version) ? 'you asked for it' : `you asked for --node ${node.requested}`;

  if (!probe) {
    return { name, pass: true, kind: 'engines-unverified', note: `nothing to import, so running under ${under} proved nothing`, node: formatVersion(node.version) };
  }

  if (probe.ok) {
    if (inRange === false) {
      return {
        name,
        pass: true,
        kind: 'engines-outside-range',
        note:
          `${asked}, and engines.node "${range}" does not accept it — the package imported there anyway, ` +
          `so the floor you declare may be higher than the one you have`,
        node: formatVersion(node.version),
      };
    }
    if (inRange === null) {
      return {
        name,
        pass: true,
        kind: declared ? 'engines-unverified' : undefined,
        note: declared
          ? `imported under ${under} (${asked}), but packproof cannot read this range, so it cannot say whether the range accepts it`
          : `imported under ${under} (${asked}) — engines.node declares nothing, so this run proves more than the manifest claims`,
        node: formatVersion(node.version),
      };
    }
    return {
      name,
      pass: true,
      note: atFloor
        ? `imported under ${under} (${asked}), the oldest version this range claims`
        : `imported under ${under} (${asked}); this range accepts it` +
          (floor ? `, though its floor of node ${floor.major} is not what ran` : ''),
      node: formatVersion(node.version),
    };
  }

  const why = whyUnsatisfied(probe.stderr);
  const what = probe.specifier ? `"${probe.specifier}"` : 'it';

  if (inRange === false) {
    return {
      name,
      pass: true,
      kind: 'engines-outside-range',
      note:
        `${asked}, which engines.node "${range}" does not accept — importing ${what} there fails` +
        (why ? ` because ${why}` : '') +
        `, which the manifest already told you. Not counted against the package`,
      node: formatVersion(node.version),
    };
  }
  if (inRange === null && declared) {
    return {
      name,
      pass: true,
      kind: 'engines-unverified',
      note:
        `importing ${what} under ${under} (${asked}) fails` +
        (why ? ` because ${why}` : '') +
        `, but packproof cannot read "${range}", so it cannot tell whether that Node was ever excluded`,
      node: formatVersion(node.version),
    };
  }
  return {
    name,
    pass: false,
    kind: 'engines-unsatisfied',
    hint: declared
      ? `this package says it runs on ${floor ? `node ${floor.major}` : 'the versions it lists'} and up, but importing ` +
        `${what} under ${under} fails` +
        (why ? `: ${why}. ` : '. ') +
        `Either raise engines.node to a version that works, or stop using what does not exist down there. ` +
        `Anyone on ${under} installs this and it does not load.`
      : `${asked}, and importing ${what} under ${under} fails` +
        (why ? `: ${why}. ` : '. ') +
        `engines.node declares nothing, so npm lets anyone on ${under} install this and it does not load. ` +
        `Declare a floor, or make it work down there.`,
    detail: firstLines(probe.stderr),
    node: formatVersion(node.version),
  };
}

/** Import every entry point under one interpreter. Null when there is nothing to import. */
function importUnder(room, manifest, execPath, timeout) {
  const specs = entrySpecifiers(manifest);
  if (!specs.length) return null;
  for (const spec of specs) {
    const r = runInRoom(room, `await import(${JSON.stringify(spec)});\nconsole.log('ok');\n`, { execPath, timeout });
    if (!r.ok) return { ok: false, stderr: r.stderr, specifier: spec };
  }
  return { ok: true, stderr: '', specifier: null };
}

/**
 * The thin runner: pick a Node, import the entry points under it, hand the
 * result to the pure classifier. No check at all when nothing was promised.
 *
 * `nodes` (from `--node`) replaces the automatic choice rather than adding to
 * it: the caller named the interpreters they care about, each one costs a full
 * re-import of every entry point, and a run that does exactly what it was told
 * is easier to trust than one that also does something else.
 */
export function checkEngines(room, manifest, { interpreters, nodes = null, timeout = 60000 } = {}) {
  const range = manifest.engines && manifest.engines.node;
  const declared = !(range === undefined || range === null || String(range).trim() === '');

  if (nodes && nodes.length) {
    return nodes.map((node) =>
      classifyRequestedNode({ range: declared ? range : null, node, probe: importUnder(room, manifest, node.path, timeout) })
    );
  }
  if (!declared) return [];

  const list = interpreters || discoverInterpreters();
  const parsed = parseRange(range);
  const floor = floorOf(parsed);
  const chosen = parsed.readable && !parsed.any ? chooseInterpreter(list, parsed, floor) : null;

  const probe = chosen ? importUnder(room, manifest, chosen.path, timeout) : null;
  return [classifyEngines({ range, interpreters: list, probe, running: process.version })];
}
