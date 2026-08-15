#!/usr/bin/env node
import { packproof, packproofWorkspaces } from './index.js';
import { FORMAT_NAMES, githubAnnotations, githubError, junitXml, junitError } from './format.js';
import { CHECK_IDS, CHECK_HELP, selectChecks, verdictLine } from './select.js';
import { CONFIG_FILENAME, CONFIG_KEYS, parseConfig, mergeConfig, configSummary } from './config.js';

const CONFIG_LINES = Object.entries(CONFIG_KEYS).map(([k, v]) => `  ${k.padEnd(16)}${v.help}`).join('\n');

const CHECK_LINES = CHECK_IDS.map((id) => `  ${id.padEnd(18)}${CHECK_HELP[id]}`).join('\n');

const HELP = `packproof — install your package like a stranger would, before they do.

  packproof [path-or-tarball] [options]

Packs your project with npm pack, installs the tarball into an empty
throwaway project where none of your devDependencies exist, then imports
every entry point and runs every bin. If it breaks there, it breaks for
your users.

If package.json declares engines.node, it imports the package again under
the oldest Node on this machine that the range accepts — and when there is
no such Node here, it says so instead of passing quietly. --node names
the interpreter yourself, by version or by path.

With --registry it skips packing and downloads an already-published
version instead, so you can prove a release after the fact — yours or
anyone else's. With --workspaces it does the whole monorepo, one
independent clean room per package.

Options
  --workspaces        prove every package the root package.json (or a
                      pnpm-workspace.yaml) declares, each in its own clean
                      room. Private packages are skipped: nobody installs
                      them. One report section per package.
  --workspace <name>  only this workspace package (repeatable; accepts the
                      package name or its directory). Implies --workspaces.
  --include-private   do not skip private workspace packages
  --registry [spec]   prove a published package instead of the local tree.
                      spec is pkg, pkg@1.2.3 or pkg@tag (default: this
                      package's name at its latest tag). The tarball is
                      checked against the integrity the registry published.
  --registry-url <u>  registry to ask (default https://registry.npmjs.org)
  --diff [version]    compare the shipped file list against an already-published
                      version (default: this package's latest). A path the
                      published package.json pointed at that is gone fails the
                      run; any other file that stopped shipping is named. Catches
                      what nothing loads and no probe can see.
  --json              machine-readable output (same as --format=json)
  --format <fmt>      human (default), json, github or junit.
                      github prints GitHub Actions annotations, so a failure
                      lands on the offending line instead of in scrollback;
                      junit writes a JUnit XML report most CI runners ingest.
  --out <file>        write the formatted report to a file instead of stdout
  --keep              keep the clean room and print its path
  --ignore-scripts    install with --ignore-scripts
  --skip-require      only probe ESM import, not require()
                      (the older spelling of --skip require)
  --lazy              also read the shipped source for imports hidden inside
                      functions and branches that merely loading the package
                      never reaches, and check those are declared too
  --strict            fail on everything packproof would otherwise only note:
                      accidental files in the tarball, a file that stopped
                      shipping without being a declared entry point, and a bin
                      that runs but exits nonzero. Same findings, stricter
                      verdict — for CI that wants none of it. An engines.node
                      claim this machine cannot verify is never promoted: that
                      is a fact about the machine, not about the package.
  --node <ver|path>   run the engines check under this Node instead of the
                      oldest installed one the range happens to accept
                      (repeatable). A bare 18 or 18.20.4 is matched against
                      the Nodes packproof can find; anything else is a path
                      to a node binary. A Node your engines.node does not
                      accept still runs, and the report says so both ways —
                      it is a question about the package, not a charge
                      against it.
  --only <checks>     run only these checks (repeatable, comma-separated)
  --skip <checks>     run everything except these. A run that skipped
                      anything says so in every format — the verdict line
                      never claims more than the run actually proved.
  --bin-args <args>   args passed to each bin (default: --version)
  --config <path>     read this config file instead of looking for one
                      (missing file: error, not a shrug)
  --no-config         ignore any packproof.json
  -h, --help          show this
  -v, --version       show packproof's version

Checks (for --only / --skip)
${CHECK_LINES}

  The import probes need the install: --skip install drops them too, and
  says so. Skipping the install means the run never proves the package
  installs — packproof will not print that it does.

Config file (packproof.json, beside your package.json)
${CONFIG_LINES}

  Say your lane once instead of in every CI job. A flag on the command
  line always beats the file, an unknown key is an error, and a run that
  used a file prints one line saying so and what it said — behaviour the
  reader of a log cannot see is the thing this tool exists to prevent.
  Nothing per-invocation lives there (--registry, --diff <version>, --out,
  --keep), and there is no "packproof" key in package.json: that file ships
  inside the tarball packproof is checking.
`;

/**
 * Which command-line flag stands for which config key. Only used to record that
 * the user typed something: the flag's own parsing is unchanged below.
 */
const FLAG_KEYS = [
  ['--only', 'only'],
  ['--skip', 'skip'],
  ['--node', 'node'],
  ['--bin-args', 'binArgs'],
  ['--lazy', 'lazy'],
  ['--strict', 'strict'],
  ['--ignore-scripts', 'ignoreScripts'],
  ['--workspaces', 'workspaces'],
  ['--workspace', 'workspaces'],
  ['--include-private', 'includePrivate'],
  ['--diff', 'diff'],
  ['--format', 'format'],
  ['--json', 'format'],
  ['--registry-url', 'registryUrl'],
];

function parse(argv) {
  // `provided` records what the user actually typed, so a config file can be
  // folded in underneath it without ever beating a flag. A default (binArgs)
  // is not "provided": nobody typed it.
  const provided = new Set();
  const opts = { target: '.', binArgs: ['--version'], provided };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    for (const [flag, key] of FLAG_KEYS) {
      if (a === flag || a.startsWith(flag + '=')) provided.add(key);
    }
    if (a === '--config') opts.configPath = String(argv[++i] ?? '');
    else if (a.startsWith('--config=')) opts.configPath = a.slice('--config='.length);
    else if (a === '--no-config') opts.noConfig = true;
    else if (a === '--registry') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) opts.registry = true;
      else opts.registry = argv[++i];
    }
    else if (a === '--registry-url') opts.registryUrl = String(argv[++i] ?? '');
    else if (a === '--diff') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) opts.diff = true;
      else opts.diff = argv[++i];
    }
    else if (a.startsWith('--diff=')) opts.diff = a.slice('--diff='.length) || true;
    else if (a === '--workspaces') opts.workspaces = true;
    else if (a === '--workspace') { (opts.workspace ||= []).push(String(argv[++i] ?? '')); opts.workspaces = true; }
    else if (a.startsWith('--workspace=')) { (opts.workspace ||= []).push(a.slice('--workspace='.length)); opts.workspaces = true; }
    else if (a === '--include-private') opts.includePrivate = true;
    else if (a === '--json') opts.format = 'json';
    else if (a === '--format') opts.format = String(argv[++i] ?? '');
    else if (a.startsWith('--format=')) opts.format = a.slice('--format='.length);
    else if (a === '--out') opts.out = String(argv[++i] ?? '');
    else if (a === '--keep') opts.keep = true;
    else if (a === '--ignore-scripts') opts.ignoreScripts = true;
    else if (a === '--skip-require') opts.skipRequire = true;
    else if (a === '--lazy') opts.lazy = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--only') (opts.only ||= []).push(String(argv[++i] ?? ''));
    else if (a.startsWith('--only=')) (opts.only ||= []).push(a.slice('--only='.length));
    else if (a === '--skip') (opts.skip ||= []).push(String(argv[++i] ?? ''));
    else if (a.startsWith('--skip=')) (opts.skip ||= []).push(a.slice('--skip='.length));
    else if (a === '--node') {
      const next = argv[i + 1];
      (opts.node ||= []).push(next === undefined || next.startsWith('-') ? '' : argv[++i]);
    }
    else if (a.startsWith('--node=')) (opts.node ||= []).push(a.slice('--node='.length));
    else if (a === '--bin-args') opts.binArgs = String(argv[++i] ?? '').split(' ').filter(Boolean);
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a.startsWith('-')) { opts.unknown = a; }
    else rest.push(a);
  }
  if (rest.length) opts.target = rest[0];
  return opts;
}

const c = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m` }
  : { dim: (s) => s, red: (s) => s, green: (s) => s, bold: (s) => s, yellow: (s) => s };

const opts = parse(process.argv.slice(2));
if (opts.help) { process.stdout.write(HELP); process.exit(0); }
if (opts.version) {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}
if (opts.unknown) { console.error(`packproof: unknown option ${opts.unknown}\n`); process.stdout.write(HELP); process.exit(2); }

/**
 * Find and read the config file, if there is one to read.
 *
 * Discovery is one directory deep and nothing more: `packproof.json` beside the
 * target's package.json (or beside the working directory, when the target is a
 * tarball and has no package.json of its own). No parent search, no package.json
 * key — see src/config.js for why. `--config` names one explicitly and a missing
 * one is an error, because a file you asked for by name and did not get is not
 * something to carry on quietly without.
 */
async function loadConfig() {
  if (opts.noConfig && opts.configPath) {
    console.error('packproof: --config names a file and --no-config ignores every file — pick one');
    process.exit(2);
  }
  if (opts.noConfig) return null;
  const { readFileSync, existsSync } = await import('node:fs');
  const { resolve, join, relative, isAbsolute } = await import('node:path');
  const display = (p) => {
    const rel = relative(process.cwd(), p);
    return !rel || rel.startsWith('..') || isAbsolute(rel) ? p : rel;
  };

  let file;
  if (opts.configPath) {
    file = resolve(process.cwd(), opts.configPath);
    if (!existsSync(file)) {
      console.error(`packproof: --config ${opts.configPath}: no such file`);
      process.exit(2);
    }
  } else {
    const isTarball = /\.(tgz|tar\.gz)$/.test(opts.target || '');
    const dir = isTarball ? process.cwd() : resolve(process.cwd(), opts.target || '.');
    file = join(dir, CONFIG_FILENAME);
    if (!existsSync(file)) return null;
  }

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`packproof: ${display(file)}: ${e.message}`);
    process.exit(2);
  }
  const parsed = parseConfig(text, { source: display(file) });
  if (!parsed.ok) {
    console.error(`packproof: ${parsed.error}`);
    process.exit(2);
  }
  const merged = mergeConfig(parsed.config, opts, opts.provided);
  Object.assign(opts, merged.opts);
  const loaded = { path: display(file), applied: merged.applied, overridden: merged.overridden };
  // The summary travels with the result so every format prints the same sentence.
  loaded.summary = configSummary(loaded);
  return loaded;
}

// The file is folded in before anything else is decided, so a lane written down
// once is refused or accepted on exactly the same terms as one typed out.
opts.config = await loadConfig();

if (opts.workspaces && opts.registry) {
  console.error('packproof: --workspaces proves a checkout and --registry proves a published version — pick one');
  process.exit(2);
}

if (opts.workspaces && opts.diff && opts.diff !== true) {
  console.error(
    'packproof: --diff with a version proves one package, but --workspaces has several — ' +
      'use a bare --diff so each package compares against its own published latest'
  );
  process.exit(2);
}

// Decide what runs before anything is packed: a contradiction should cost the
// user nothing, and a refusal is never resolved by guessing which half was meant.
const selection = selectChecks({
  only: opts.only,
  skip: [].concat(opts.skip || [], opts.skipRequire ? ['require'] : []),
  requested: { diff: !!opts.diff, lazy: !!opts.lazy, node: !!(opts.node && opts.node.length) },
});
if (!selection.ok) {
  console.error(`packproof: ${selection.error}`);
  process.exit(2);
}
opts.selection = selection;

// Same rule for --node: an interpreter that cannot be found or cannot be run is
// an error before anything is packed, never a mystery failure halfway through.
if (opts.node) {
  const { resolveNodes } = await import('./engines.js');
  const resolved = resolveNodes(opts.node);
  if (!resolved.ok) {
    console.error(`packproof: ${resolved.error}`);
    process.exit(2);
  }
  opts.nodes = resolved.nodes;
}

const format = opts.format || 'human';
if (!FORMAT_NAMES.includes(format)) {
  console.error(`packproof: unknown format "${format}" — pick one of ${FORMAT_NAMES.join(', ')}`);
  process.exit(2);
}

/** Report text goes to --out if asked, otherwise stdout. Exit code is unchanged either way. */
async function emit(text) {
  if (!opts.out) { process.stdout.write(text); return; }
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, text);
}

let result;
try {
  result = opts.workspaces ? await packproofWorkspaces(opts.target, opts) : await packproof(opts.target, opts);
} catch (e) {
  if (format === 'json') await emit(JSON.stringify({ ok: false, error: e.message }, null, 2) + '\n');
  else if (format === 'github') await emit(githubError(e.message));
  else if (format === 'junit') await emit(junitError(e.message));
  else console.error(c.red(`packproof: ${e.message}`));
  process.exit(2);
}

if (format !== 'human') {
  if (format === 'json') await emit(JSON.stringify(result, null, 2) + '\n');
  else if (format === 'github') await emit(githubAnnotations(result));
  else await emit(junitXml(result));
  process.exit(result.ok ? 0 : 1);
}

// Where the behaviour came from, before any of the behaviour. One line, always
// printed when a file was read — including a file every flag overrode, because
// it was still read and the reader still needs to know it exists.
const configLine = opts.config && opts.config.summary;
if (configLine) console.log(c.dim(configLine));

/** One package's section: the header line, then every check under it. */
function printPackage(r) {
  const provenance =
    r.source === 'registry'
      ? `— ${r.fileCount} files, published to ${r.registry.url.replace(/^https?:\/\//, '')}`
      : `— ${r.fileCount} files packed`;
  const where = r.workspaceDir ? c.dim(` ${r.workspaceDir}`) : '';
  console.log(`${c.bold(`${r.name}@${r.version}`)}${where} ${c.dim(provenance)}`);
  for (const chk of r.checks) {
    if (chk.pass) {
      console.log(`  ${c.green('✓')} ${chk.name}${chk.note ? c.dim(` — ${chk.note}`) : ''}`);
    } else {
      console.log(`  ${c.red('✗')} ${chk.name} ${c.dim(`[${chk.kind}]`)}`);
      if (chk.hint) console.log(`      ${c.yellow(chk.hint)}`);
      if (chk.detail) for (const line of chk.detail.split('\n')) console.log(c.dim(`      ${line}`));
    }
  }
  for (const sk of r.skippedChecks || []) {
    console.log(`  ${c.dim('-')} ${sk.id} ${c.dim(`— did not run, ${sk.reason}`)}`);
  }
  if (r.room) console.log(c.dim(`\nclean room kept at ${r.room}`));
}

/**
 * What to publish first. Only worth printing when there is more than one
 * package to order; a cycle prints the loop instead of an order, because there
 * is no order that works.
 */
function printReleaseOrder(order) {
  if (!order || order.packageCount < 2) return;
  if (order.cycles.length) {
    console.log(`${c.bold('release order')} — none exists ${c.dim('[workspace-dependency-cycle]')}`);
    for (const cyc of order.cycles) console.log(`  ${c.red(cyc.path.join(' → '))}`);
    console.log(
      c.yellow(
        `  these packages depend on each other, so none of them can be published first at a version\n` +
          `  the others' ranges resolve to. Break the cycle — or publish them together, by hand, once.`
      )
    );
    if (order.unordered.length > order.cycles.reduce((n, cy) => n + cy.packages.length, 0)) {
      console.log(c.dim(`  waiting behind it: ${order.unordered.join(', ')}`));
    }
    return;
  }
  if (!order.edgeCount) {
    console.log(`${c.bold('release order')} — ${c.dim('any order works: no package here depends on another')}`);
    return;
  }
  console.log(
    `${c.bold('release order')} — ${order.stepCount} step${order.stepCount === 1 ? '' : 's'}, ` +
      c.dim('leaves first: publish each step before the next')
  );
  const width = Math.max(...order.steps.map((s) => s.name.length));
  for (const step of order.steps) {
    const needs = step.needs.length ? c.dim(` — needs ${step.needs.join(', ')}`) : '';
    const pad = step.needs.length ? ' '.repeat(width - step.name.length) : '';
    console.log(`  ${step.step}. ${step.name}${pad}${needs}`);
  }
}

if (result.workspaces) {
  const n = result.packageCount;
  console.log(
    `${c.bold(result.rootName || result.root || 'workspace')} ${c.dim(
      `— ${n} package${n === 1 ? '' : 's'} from ${result.workspaceSource}, one clean room each`
    )}\n`
  );
  for (const r of result.packages) {
    printPackage(r);
    console.log('');
  }
  for (const s of result.skipped) {
    console.log(c.dim(`- ${s.name} ${s.dir} — skipped, ${s.reason}`));
  }
  if (result.skipped.length) console.log('');
  const printed = result.releaseOrder && result.releaseOrder.packageCount > 1;
  printReleaseOrder(result.releaseOrder);
  if (printed) console.log('');
  const bad = result.packages.filter((r) => !r.ok);
  const partial = (result.skippedChecks || []).length;
  const names = (result.skippedChecks || []).map((sk) => sk.id).join(', ');
  if (!result.ok) {
    console.log(
      c.red(
        `packproof: ${result.failures.length} problem${result.failures.length === 1 ? '' : 's'} your users would hit, in ` +
          `${bad.length} of ${n} package${n === 1 ? '' : 's'} (${bad.map((r) => r.name).join(', ')}).` +
          (partial ? ` ${partial} check${partial === 1 ? ' was' : 's were'} skipped (${names}).` : '')
      )
    );
  } else if (!partial) {
    console.log(c.green(`packproof: all ${n} package${n === 1 ? ' works' : 's work'} when installed.`));
  } else if (!result.installed) {
    console.log(
      c.yellow(
        `packproof: everything this run looked at is fine across ${n} package${n === 1 ? '' : 's'} — but it never ` +
          `installed any of them, so it proves nothing about installing them. Skipped: ${names}.`
      )
    );
  } else {
    console.log(
      c.yellow(
        `packproof: all ${n} package${n === 1 ? ' works' : 's work'} when installed — but ${partial} ` +
          `check${partial === 1 ? '' : 's'} did not run (${names}), so this is not a full proof.`
      )
    );
  }
  process.exit(result.ok ? 0 : 1);
}

printPackage(result);
const verdict = `packproof: ${verdictLine({ skipped: result.skippedChecks, installed: result.installed }, { failures: result.failures.length })}`;
console.log('\n' + (result.ok ? (result.fullRun ? c.green(verdict) : c.yellow(verdict)) : c.red(verdict)));
process.exit(result.ok ? 0 : 1);
