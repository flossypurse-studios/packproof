#!/usr/bin/env node
import { packproof } from './index.js';

const HELP = `packproof — install your package like a stranger would, before they do.

  packproof [path-or-tarball] [options]

Packs your project with npm pack, installs the tarball into an empty
throwaway project where none of your devDependencies exist, then imports
every entry point and runs every bin. If it breaks there, it breaks for
your users.

Options
  --json              machine-readable output
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
    if (a === '--json') opts.json = true;
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

let result;
try {
  result = await packproof(opts.target, opts);
} catch (e) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  else console.error(c.red(`packproof: ${e.message}`));
  process.exit(2);
}

if (opts.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

console.log(`${c.bold(`${result.name}@${result.version}`)} ${c.dim(`— ${result.fileCount} files packed`)}`);
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
