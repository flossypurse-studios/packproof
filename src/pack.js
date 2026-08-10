import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';

/** Read and parse a package.json, throwing a friendly error. */
export function readManifest(dir) {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) throw new Error(`no package.json found in ${dir}`);
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`could not parse ${p}: ${e.message}`);
  }
}

/**
 * Produce a tarball for `target`. If target is already a .tgz, use it as-is.
 * Otherwise run `npm pack` so we get exactly the bytes npm would publish.
 */
export function makeTarball(target, { cwd = process.cwd() } = {}) {
  const abs = resolve(cwd, target);
  if (abs.endsWith('.tgz') || abs.endsWith('.tar.gz')) {
    if (!existsSync(abs)) throw new Error(`tarball not found: ${abs}`);
    return { tarball: abs, packed: false };
  }
  const out = mkdtempSync(join(tmpdir(), 'packproof-pack-'));
  const stdout = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], {
    cwd: abs,
    encoding: 'utf8',
  });
  const name = stdout.trim().split('\n').filter(Boolean).pop();
  const tarball = join(out, basename(name || ''));
  if (!name || !existsSync(tarball)) throw new Error('npm pack did not produce a tarball');
  return { tarball, packed: true };
}

/** List the files inside a tarball, with the leading `package/` stripped. */
export function tarballFiles(tarball) {
  const out = execFileSync('tar', ['tzf', tarball], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.endsWith('/'))
    .map((l) => l.replace(/^package\//, ''));
}
