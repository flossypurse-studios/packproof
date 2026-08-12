// --registry mode: prove the bytes that are already published.
//
// Everything else in packproof asks "would this tree survive publishing?".
// This asks the question after the fact, about any package on the registry —
// yours or a stranger's. No dependencies: node's fetch, tar and crypto.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Split `pkg`, `pkg@1.2.3`, `@scope/pkg@next` into a name and what we want. */
export function parseSpec(spec) {
  const s = String(spec ?? '').trim();
  if (!s) throw new Error('--registry: expected a package spec like pkg@1.2.3');
  if (/^[.~/]/.test(s) || /^[a-z]+:\/\//i.test(s) || /\.(tgz|tar\.gz)$/.test(s)) {
    throw new Error(`--registry: "${s}" looks like a path or URL; expected a package spec like pkg@1.2.3`);
  }
  const at = s.lastIndexOf('@');
  let name = s;
  let wanted = 'latest';
  if (at > 0) {
    name = s.slice(0, at);
    wanted = s.slice(at + 1) || 'latest';
  }
  if (!name) throw new Error(`--registry: expected a package spec like pkg@1.2.3, got "${s}"`);
  if (name.includes('/') && !name.startsWith('@')) {
    throw new Error(`--registry: "${name}" has a slash but is not a scoped name (@scope/name)`);
  }
  return { name, wanted };
}

/** The registry URL for a packument, scoped names encoded the way npm does it. */
export function packumentUrl(name, registryUrl = DEFAULT_REGISTRY) {
  return `${String(registryUrl).replace(/\/+$/, '')}/${name.replace('/', '%2f')}`;
}

/** Turn a dist-tag or exact version into an exact version, or say why not. */
export function resolveVersion(packument, wanted) {
  const tags = packument['dist-tags'] || {};
  if (Object.prototype.hasOwnProperty.call(tags, wanted)) return tags[wanted];
  const versions = packument.versions || {};
  if (Object.prototype.hasOwnProperty.call(versions, wanted)) return wanted;
  if (/^[\^~><=]|\s|\|\||^\d+\.(x|\*)|\.x$|\*/.test(wanted)) {
    throw new Error(
      `--registry: "${wanted}" is a semver range. packproof proves one exact set of bytes, ` +
        `so give it an exact version or a dist-tag (${Object.keys(tags).join(', ') || 'none published'}).`
    );
  }
  const all = Object.keys(versions);
  const shown = all.slice(-5).join(', ');
  throw new Error(
    `--registry: ${packument.name}@${wanted} is not published. ` +
      `tags: ${Object.keys(tags).map((t) => `${t}=${tags[t]}`).join(', ') || 'none'}` +
      (shown ? `; latest versions: ${shown}` : '')
  );
}

/** Where the tarball for an exact version lives, and what it should hash to. */
export function distFor(packument, version) {
  const v = (packument.versions || {})[version];
  if (!v) throw new Error(`--registry: ${packument.name}@${version} is missing from the packument`);
  const dist = v.dist || {};
  if (!dist.tarball) {
    throw new Error(
      `--registry: ${packument.name}@${version} has no tarball — it was probably unpublished.`
    );
  }
  return { url: dist.tarball, integrity: dist.integrity || null, shasum: dist.shasum || null };
}

/**
 * Check downloaded bytes against what the registry says they are.
 * `algorithm: null` means the registry told us nothing to check against —
 * reported, never silently treated as a verified pass.
 */
export function verifyIntegrity(buffer, { integrity, shasum } = {}) {
  if (integrity) {
    // Registries may list several hashes; any one matching is a match.
    let firstFail = null;
    for (const entry of String(integrity).trim().split(/\s+/)) {
      const dash = entry.indexOf('-');
      if (dash < 1) continue;
      const algorithm = entry.slice(0, dash);
      const expected = entry.slice(dash + 1);
      let actual;
      try {
        actual = createHash(algorithm).update(buffer).digest('base64');
      } catch {
        continue; // an algorithm this node build does not know
      }
      if (actual === expected) return { ok: true, algorithm, expected, actual };
      if (!firstFail) firstFail = { ok: false, algorithm, expected, actual };
    }
    if (firstFail) return firstFail;
  }
  if (shasum) {
    const actual = createHash('sha1').update(buffer).digest('hex');
    return { ok: actual === shasum, algorithm: 'sha1', expected: shasum, actual };
  }
  return { ok: true, algorithm: null, expected: null, actual: null };
}

/** Read the published package.json straight out of the tarball bytes. */
export function manifestFromTarball(tarball) {
  const out = execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`could not parse package.json inside ${tarball}: ${e.message}`);
  }
}

async function getJson(url, name) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json, application/json' } });
  } catch (e) {
    throw new Error(`--registry: could not reach ${url} (${e.message})`);
  }
  if (res.status === 404) throw new Error(`--registry: no such package ${name} on ${url.slice(0, url.lastIndexOf('/'))}`);
  if (!res.ok) throw new Error(`--registry: ${url} answered ${res.status} ${res.statusText || ''}`.trim());
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`--registry: ${url} did not return JSON (${e.message})`);
  }
}

/**
 * Resolve a spec, download the tarball, verify it, and hand back a path the
 * rest of packproof can treat exactly like the output of `npm pack`.
 */
export async function fetchRegistryTarball(spec, { registryUrl = DEFAULT_REGISTRY } = {}) {
  const { name, wanted } = parseSpec(spec);
  const base = String(registryUrl).replace(/\/+$/, '');
  const packument = await getJson(packumentUrl(name, base), name);
  if (!packument || typeof packument !== 'object' || (!packument.versions && !packument['dist-tags'])) {
    throw new Error(`--registry: ${name} has no published versions at ${base}`);
  }
  packument.name = packument.name || name;
  const version = resolveVersion(packument, wanted);
  const dist = distFor(packument, version);

  let res;
  try {
    res = await fetch(dist.url);
  } catch (e) {
    throw new Error(`--registry: could not download ${dist.url} (${e.message})`);
  }
  if (!res.ok) throw new Error(`--registry: ${dist.url} answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const integrity = verifyIntegrity(bytes, dist);

  const dir = mkdtempSync(join(tmpdir(), 'packproof-registry-'));
  const tarball = join(dir, `${name.replace('/', '-').replace(/^@/, '')}-${version}.tgz`);
  writeFileSync(tarball, bytes);

  return {
    tarball,
    name,
    version,
    wanted,
    spec: `${name}@${wanted}`,
    registryUrl: base,
    tarballUrl: dist.url,
    bytes: bytes.length,
    integrity,
  };
}
