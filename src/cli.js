#!/usr/bin/env node
import { packproof } from './index.js';
import { FORMAT_NAMES, githubAnnotations, githubError, junitXml, junitError } from './format.js';

const HELP = `packproof — install your package like a stranger would, before they do.

  packproof [path-or-tarball] [options]

Packs your project with npm pack, installs the tarball into an empty
throwaway project where none of your devDependencies exist, then imports
every entry point and runs every bin. If it breaks there, it breaks for
your users.

With --registry it skips packing and downloads an already-published
version instead, so you can prove a release after the fact — yours or
anyone else's.

Options
  --registry [spec]   prove a published package instead of the local tree.
                      spec is pkg, pkg@1.2.3 or pkg@tag (default: this
                      package's name at its latest tag). The tarball is
                      checked against the integrity the registry published.
  --registry-url <u>  registry to ask (default https://registry.npmjs.org)
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
  result = await packproof(opts.target, opts);
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

const provenance =
  result.source === 'registry'
    ? `— ${result.fileCount} files, published to ${result.registry.url.replace(/^https?:\/\//, '')}`
    : `— ${result.fileCount} files packed`;
console.log(`${c.bold(`${result.name}@${result.version}`)} ${c.dim(provenance)}`);
for (const chk of result.checks) {
  if (chk.pass) {
    console.log(`  ${c.green('✓')} ${chk.name}${chk.note ? c.dim(` — ${chk.note}`) : ''}`);
  } else {
    console.log(`  ${c.red('✗')} ${chk.name} ${c.dim(`[${chk.kind}]`)}`);
    if (chk.hint) console.log(`      ${c.yellow(chk.hint)}`);
    if (chk.detail) for (const line of chk.detail.split('\n')) console.log(c.dim(`      ${line}`));
  }
}
if (result.room) console.log(c.dim(`\nclean room kept at ${result.room}`));
console.log(
  result.ok
    ? `\n${c.green('packproof: this package works when installed.')}`
    : `\n${c.red(`packproof: ${result.failures.length} problem${result.failures.length === 1 ? '' : 's'} your users would hit.`)}`
);
process.exit(result.ok ? 0 : 1);
