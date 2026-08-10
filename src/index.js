import { makeTarball, readManifest, tarballFiles } from './pack.js';
import { createCleanRoom, installTarball } from './cleanroom.js';
import { checkEntries, checkRequire, checkBins } from './checks.js';
import { checkLazyImports } from './lazy.js';
import { resolve } from 'node:path';

/**
 * Pack the project, install it into a clean room, and prove it works.
 * Returns a plain result object; the CLI does all the printing.
 */
export async function packproof(target = '.', opts = {}) {
  const started = Date.now();
  const isTarball = /\.(tgz|tar\.gz)$/.test(target);
  const manifestDir = isTarball ? (opts.manifestDir || process.cwd()) : resolve(process.cwd(), target);
  const manifest = readManifest(manifestDir);
  const { tarball, packed } = makeTarball(target);
  const files = tarballFiles(tarball);

  const room = createCleanRoom();
  const checks = [];
  let install;
  try {
    install = installTarball(room, tarball, { ignoreScripts: opts.ignoreScripts });
    if (!install.ok) {
      checks.push({
        name: 'npm install <tarball>',
        pass: false,
        kind: 'install-failed',
        hint: 'the package could not even be installed into an empty project.',
        detail: (install.stderr || install.error || '').split('\n').slice(0, 5).join('\n'),
      });
      return finish({ manifest, tarball, packed, files, checks, started, room, opts });
    }
    checks.push({ name: 'npm install <tarball>', pass: true });
    checks.push(...checkEntries(room, manifest));
    if (!opts.skipRequire) checks.push(...checkRequire(room, manifest));
    checks.push(...checkBins(room, manifest, { binArgs: opts.binArgs }));
    if (opts.lazy) {
      // Don't say the same thing twice: if loading already blew up on a package,
      // the deep probe has nothing to add about it.
      const already = new Set(checks.filter((c) => !c.pass && c.missing).map((c) => c.missing));
      checks.push(...checkLazyImports(room, manifest, files, { already }));
    }
  } finally {
    if (!opts.keep) room.cleanup();
  }
  return finish({ manifest, tarball, packed, files, checks, started, room, opts });
}

function finish({ manifest, tarball, packed, files, checks, started, room, opts }) {
  const failed = checks.filter((c) => !c.pass);
  return {
    name: manifest.name,
    version: manifest.version,
    tarball,
    packed,
    files,
    fileCount: files.length,
    checks,
    failures: failed,
    ok: failed.length === 0,
    room: opts.keep ? room.dir : null,
    durationMs: Date.now() - started,
  };
}
