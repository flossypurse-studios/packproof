#!/usr/bin/env node
import { packproof, packproofWorkspaces } from './index.js';
import { FORMAT_NAMES, githubAnnotations, githubError, junitXml, junitError } from './format.js';

const HELP = `packproof — install your package like a stranger would, before they do.

  packproof [path-or-tarball] [options]

Packs your project with npm pack, installs the tarball into an empty
throwaway project where none of your devDependencies exist, then imports
every entry point and runs every bin. If it breaks there, it breaks for
your users.

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
  --lazy              also read the shipped source for imports hidden inside
                      functions and branches that merely loading the package
                      never reaches, and check those are declared too
  --bin-args <args>   args passed to each bin (default: --version)
  -h, --help          show this
  -v, --version       show packproof's version
`;

function parse(argv) {
  const opts = { target: '.', binArgs: ['--version'] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--registry') {
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
  console.log(
    result.ok
      ? c.green(`packproof: all ${n} package${n === 1 ? ' works' : 's work'} when installed.`)
      : c.red(
          `packproof: ${result.failures.length} problem${result.failures.length === 1 ? '' : 's'} your users would hit, in ` +
            `${bad.length} of ${n} package${n === 1 ? '' : 's'} (${bad.map((r) => r.name).join(', ')}).`
        )
  );
  process.exit(result.ok ? 0 : 1);
}

printPackage(result);
console.log(
  result.ok
    ? `\n${c.green('packproof: this package works when installed.')}`
    : `\n${c.red(`packproof: ${result.failures.length} problem${result.failures.length === 1 ? '' : 's'} your users would hit.`)}`
);
process.exit(result.ok ? 0 : 1);
