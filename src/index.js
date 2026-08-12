import { makeTarball, readManifest, tarballFiles } from './pack.js';
import { createCleanRoom, installTarball } from './cleanroom.js';
import { checkEntries, checkRequire, checkBins } from './checks.js';
import { checkLazyImports } from './lazy.js';
import { fetchRegistryTarball, manifestFromTarball, DEFAULT_REGISTRY } from './registry.js';
import { resolve } from 'node:path';

/**
 * Pack the project (or download an already-published version), install it into
 * a clean room, and prove it works. Returns a plain result object; the CLI does
 * all the printing.
 */
export async function packproof(target = '.', opts = {}) {
  const started = Date.now();
  const checks = [];
  let manifest;
  let tarball;
  let packed = false;
  let source = 'local';
  let registry = null;

  if (opts.registry) {
    // `--registry` with no spec means "this package, as published".
    const spec =
      opts.registry === true
        ? `${readManifest(resolve(process.cwd(), target === '.' ? '.' : target)).name}@latest`
        : opts.registry;
    const got = await fetchRegistryTarball(spec, { registryUrl: opts.registryUrl || DEFAULT_REGISTRY });
    tarball = got.tarball;
    source = 'registry';
    registry = {
      spec: got.spec,
      url: got.registryUrl,
      tarballUrl: got.tarballUrl,
      bytes: got.bytes,
      integrity: got.integrity,
    };
    const label = `fetch ${got.name}@${got.version} from registry`;
    if (!got.integrity.ok) {
      checks.push({
        name: label,
        pass: false,
        kind: 'integrity-mismatch',
        hint:
          `the downloaded tarball does not match the ${got.integrity.algorithm} integrity the registry ` +
          `published for it. Nothing was installed. Retry; if it persists, the bytes in transit are not the bytes on record.`,
        detail: `expected ${got.integrity.expected}\nactual   ${got.integrity.actual}`,
      });
      manifest = { name: got.name, version: got.version };
      return finish({ manifest, tarball, packed, files: [], checks, started, room: null, opts, source, registry });
    }
    checks.push({
      name: label,
      pass: true,
      note: got.integrity.algorithm
        ? `${(got.bytes / 1024).toFixed(1)} kB, ${got.integrity.algorithm} integrity verified`
        : `${(got.bytes / 1024).toFixed(1)} kB, no integrity published to verify against`,
    });
    manifest = manifestFromTarball(tarball);
  } else {
    const isTarball = /\.(tgz|tar\.gz)$/.test(target);
    const manifestDir = isTarball ? (opts.manifestDir || process.cwd()) : resolve(process.cwd(), target);
    manifest = readManifest(manifestDir);
    const made = makeTarball(target);
    tarball = made.tarball;
    packed = made.packed;
  }

  const files = tarballFiles(tarball);
  const room = createCleanRoom();
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
      return finish({ manifest, tarball, packed, files, checks, started, room, opts, source, registry });
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
  return finish({ manifest, tarball, packed, files, checks, started, room, opts, source, registry });
}

function finish({ manifest, tarball, packed, files, checks, started, room, opts, source, registry }) {
  const failed = checks.filter((c) => !c.pass);
  return {
    name: manifest.name,
    version: manifest.version,
    source: source || 'local',
    registry: registry || null,
    tarball,
    packed,
    files,
    fileCount: files.length,
    checks,
    failures: failed,
    ok: failed.length === 0,
    room: opts.keep && room ? room.dir : null,
    durationMs: Date.now() - started,
  };
}
