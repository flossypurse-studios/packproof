// What each check group actually proves — and, the half that matters, what it does not.
//
// packproof's whole claim is that a green run means something specific. That
// claim is only worth having if the reader can find out what the specific thing
// is, without reading the source or trusting a marketing sentence. `--why
// <check-id>` prints it: two lists per check, one of things the check
// establishes and one of things a passing check is silent about.
//
// The wording here is deliberately the same wording as README's "Honest
// limitations" section — one truth, said in the terminal as well as on the page.
// The map is keyed by CHECK_IDS and a test asserts every id has an entry, so a
// new check group cannot ship without someone writing down its limits.
//
// Pure data and string building: no filesystem, no network, no process.

import { CHECK_IDS, CHECK_HELP, NEEDS_INSTALL } from './select.js';

/**
 * One entry per check group.
 *
 * `proves` — what a pass establishes, stated as narrowly as it is true.
 * `cannot` — what a pass says nothing about. Never softened: if the check is
 *            names rather than contents, or static rather than executed, that
 *            belongs here in those words.
 */
export const WHY = {
  'shipped-files': {
    proves: [
      'the exact list of paths `npm pack` produced — the files a stranger receives, not the files in your checkout',
      'that none of those paths is the kind of file that carries a credential (.npmrc, .env, id_rsa, .pem and friends): finding one fails the run',
      'that ordinary accidents are named — test directories, editor config, lockfiles, CI workflows shipped to users who cannot use them',
    ],
    cannot: [
      'read a file. This check is names, not contents: an empty .npmrc is still reported, and a token hard-coded in dist/index.js is not',
      'see a file you did not ship. The list it reads is the tarball\'s, so anything excluded from `files` is out of scope by construction',
      'tell you whether a file you meant to ship is missing — that is the diff check, against a version you already published',
    ],
  },
  diff: {
    proves: [
      'which paths this tarball ships that the published version did not, and which the published version shipped that this one does not',
      'that no path the published package.json pointed at (an entry point, a bin) has silently stopped shipping — that fails the run',
      'the one class of breakage nothing loads and no probe can see: a file that quietly left the tarball',
    ],
    cannot: [
      'compare contents. It compares paths: a file whose bytes changed completely is not a difference here',
      'tell a rename from a deletion plus an addition. Both are reported, side by side, and you decide which it was',
      'look further back than the single version you named — not every version you have ever published',
      'work offline. It needs the registry, and it fails loudly (diff-unavailable) rather than passing quietly when it cannot reach it',
    ],
  },
  install: {
    proves: [
      'that `npm install <your-tarball>` succeeds in an empty project where none of your devDependencies exist',
      'that your declared dependencies resolve and install from the registry, as a user\'s install would',
      'that whatever your install scripts do, they do it without failing (unless --ignore-scripts was passed, which says so)',
    ],
    cannot: [
      'be skipped without cost: every import probe needs the clean room this fills, so --skip install drops them too and the run stops claiming the package installs',
      'prove the install is fast, small, or free of warnings — only that it completed',
      'avoid the network or your postinstall scripts. It is a real install; that is the point. --ignore-scripts opts out of the scripts, not the network',
    ],
  },
  entries: {
    proves: [
      'that every entry point in exports / main / module can actually be imported out of the installed package',
      'that everything those modules reach at load time is declared as a dependency — an import that resolves only in your checkout fails here (undeclared-dependency)',
      'that the paths your package.json advertises exist inside the tarball, under the names it advertises them by',
    ],
    cannot: [
      'report more than one failure per probe. ESM stops at the first unresolved import, so a module with two missing things reports one, then the other after you fix it. Separate entry points are probed separately, so those are reported together',
      'run code nothing loads. Loading a module runs its top level; a devDependency imported inside a function packproof never calls is never executed — that is what --lazy reads the source for',
      'tell you whether the thing you exported is correct. It proves the module loads, never that a function in it returns the right answer',
    ],
  },
  require: {
    proves: [
      'that every entry point also loads through `require()`, which is how a large share of real users will load it',
      'that a dual package\'s CommonJS half exists and resolves — the failure a pure-ESM test suite never sees',
    ],
    cannot: [
      'succeed for a package that is ESM-only by design, and that is not a bug: --skip require (or the older --skip-require) says you meant it',
      'see past the same first-failure limit as the import probe: one unresolved specifier per entry point per run',
      'prove the CommonJS and ESM halves behave the same. It proves both load',
    ],
  },
  bins: {
    proves: [
      'that every command in package.json "bin" exists in the tarball, is executable, and runs',
      'that its shebang and its own imports resolve in a project that has only its declared dependencies',
    ],
    cannot: [
      'know what your CLI does. Bins are run with --version by default; if yours does not support it, a nonzero exit is a note rather than a failure. --bin-args gives it something real, --strict makes the note count',
      'test more than one invocation. One set of arguments per bin, per run',
      'check the bins under any Node but the current one, even when the engines check is running others',
    ],
  },
  engines: {
    proves: [
      'that your entry points import successfully under a Node that engines.node accepts — by default the oldest such Node on this machine, or exactly the ones --node names',
      'the report says which interpreter was used, every time, so the claim is checkable rather than implied',
    ],
    cannot: [
      'download a Node. If the oldest Node your range accepts is not installed here, the check passes with a note naming the Node it did use and saying the floor is unverified — it will not pretend. --strict deliberately does not promote that note: it is a fact about the machine, not the package',
      'find a Node anywhere it does not look. It reads nvm, fnm, n, volta and asdf version directories plus the Node it is running as; a Node elsewhere on your PATH is missed rather than guessed at',
      'count a Node outside your declared range against you. Such a Node still runs and is reported both ways round as a pass (engines-outside-range) — the package never promised it',
      'do more than re-import entry points. Bins are executed once, under the current Node',
    ],
  },
  peers: {
    proves: [
      'what happens when a declared peerDependency is genuinely absent: the package is installed again with --legacy-peer-deps and no peer present, and every entry point is imported',
      'that a peer your code needs at load time is not quietly optional — importing it without the peer fails here rather than in a user\'s app',
    ],
    cannot: [
      'test version ranges. It tests absence: it never installs a peer at some other version to see whether your ^18 was honest',
      'notice a package you import without declaring at all — the ordinary entry probes catch that as undeclared-dependency',
      'distinguish your missing peers from your dependencies\' ones with certainty: --legacy-peer-deps removes both, which is why a missing package nobody here declared is reported as a note rather than counted against you',
    ],
  },
  lazy: {
    proves: [
      'that import and require specifiers written inside functions and branches — code merely loading the package never reaches — are declared dependencies too',
      'the one thing execution cannot reach: a lazy require of a devDependency on an error path that only fires in production',
    ],
    cannot: [
      'execute anything. It is a static scan of the shipped text: comments and template-literal prose are blanked out first, but nothing is run, so a specifier that resolves is only proved *declared*, not proved *working*',
      'see a specifier your code computes. require(name) or import(base + mod) is not a literal and cannot be read',
      'look outside the tarball. It reads only files that actually shipped, so anything excluded from `files` is out of scope',
    ],
  },
};

/** The one-line summary a check is already described by, in --help and the report. */
export function whySummary(id) {
  return CHECK_HELP[id] || '';
}

/**
 * Look up one check. Unknown ids are refused the way --only refuses them: name
 * the real ids, never guess at the typo.
 */
export function whyFor(id) {
  const wanted = String(id ?? '').trim();
  const entry = WHY[wanted];
  if (!entry) {
    return {
      ok: false,
      error: `unknown check "${wanted}" in --why — pick from ${CHECK_IDS.join(', ')}`,
    };
  }
  return { ok: true, id: wanted, entry };
}

/**
 * Wrap to a fixed width. A terminal that is narrower will wrap again and a wider
 * one leaves a ragged right edge, which is the trade every man page makes: the
 * text is prose and prose is read, not measured.
 */
export function wrap(text, width = 78, indent = '') {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if ((line + ' ' + word).length + indent.length <= width) line += ' ' + word;
    else { out.push(indent + line); line = word; }
  }
  if (line) out.push(indent + line);
  return out.join('\n');
}

function bullets(lines) {
  return lines
    .map((l) => {
      const body = wrap(l, 78, '      ');
      return '    - ' + body.slice('      '.length);
    })
    .join('\n');
}

/** The full text for one check: what it proves, then what it cannot. */
export function whyText(id) {
  const found = whyFor(id);
  if (!found.ok) return found;
  const { entry } = found;
  const needsInstall = NEEDS_INSTALL.includes(found.id)
    ? wrap(
        'Needs the install check: without an install there is nothing to import, so --skip install drops this check too — and the run says it did.',
        78,
        '  '
      ) + '\n\n'
    : '';
  const text =
    `${found.id} — ${whySummary(found.id)}\n\n` +
    needsInstall +
    `  A passing ${found.id} check proves\n${bullets(entry.proves)}\n\n` +
    `  It cannot\n${bullets(entry.cannot)}\n`;
  return { ok: true, id: found.id, text };
}

/** Every check, one line each, plus how to read the rest. */
export function whyIndex() {
  const width = Math.max(...CHECK_IDS.map((id) => id.length)) + 2;
  const lines = CHECK_IDS.map((id) => `  ${id.padEnd(width)}${whySummary(id)}`);
  return (
    'packproof checks, and what each one is worth\n\n' +
    lines.join('\n') +
    '\n\n' +
    '  packproof --why <check-id>   what that check proves, and what it does not\n' +
    '  packproof --why all          every check, in full\n\n' +
    '  A packproof run is only worth the specific claims it makes. These are the\n' +
    '  claims, and their limits, in the same words as the README.\n'
  );
}

/** Every check in full, in run order — `--why all`. */
export function whyAll() {
  return CHECK_IDS.map((id) => whyText(id).text).join('\n');
}

/**
 * The same content as data, for `--why --json`: a site, a docs page or a
 * reviewer's script should not have to scrape the terminal output to get it.
 * `ids` defaults to every check, in run order.
 */
export function whyJson(ids = CHECK_IDS) {
  return {
    checks: [].concat(ids).map((id) => ({
      id,
      summary: whySummary(id),
      needsInstall: NEEDS_INSTALL.includes(id),
      proves: WHY[id].proves.slice(),
      cannot: WHY[id].cannot.slice(),
    })),
  };
}
