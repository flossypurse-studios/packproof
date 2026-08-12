// Workspace (monorepo) awareness.
//
// A monorepo publishes several packages from one checkout, and each of them is
// a separate promise to a stranger: each gets packed and clean-roomed on its
// own. Nothing here shares a clean room between packages — sharing one would
// hide exactly the bug packproof exists to find.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { readManifest } from './pack.js';

/** Directories never worth walking into when looking for workspace packages. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out']);
const MAX_DEPTH = 6;

/**
 * The workspace globs declared by a root package.json (npm/yarn/bun style:
 * either an array or `{ packages: [...] }`). Returns [] when there are none.
 */
export function npmWorkspaceGlobs(manifest) {
  const ws = manifest && manifest.workspaces;
  if (!ws) return [];
  const list = Array.isArray(ws) ? ws : Array.isArray(ws.packages) ? ws.packages : [];
  return list.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim());
}

/**
 * The globs in a pnpm-workspace.yaml. Deliberately not a YAML parser: this
 * reads the one shape the file ever has — a `packages:` key and a list of
 * quoted or bare globs under it — and gives up on anything else.
 */
export function pnpmWorkspaceGlobs(text) {
  const globs = [];
  let inPackages = false;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
    if (!/^\s/.test(line)) { inPackages = false; continue; } // a new top-level key
    if (!inPackages) continue;
    const m = line.match(/^\s*-\s*(.+)$/);
    if (!m) continue;
    const g = m[1].trim().replace(/^['"]/, '').replace(/['"]$/, '');
    if (g) globs.push(g);
  }
  return globs;
}

/** Turn one workspace glob into an anchored regex over a posix relative path. */
function globToRegExp(glob) {
  const body = glob
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .map((seg) => {
      if (seg === '**') return '\u0000'; // placeholder, joined specially below
      return seg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');
    })
    .join('/')
    // `**/` matches any number of leading segments, a trailing `**` matches the rest
    .replace(/\u0000\//g, '(?:[^/]+/)*')
    .replace(/\/\u0000/g, '(?:/.+)?')
    .replace(/\u0000/g, '.+');
  return new RegExp(`^${body}$`);
}

/** Every directory under root that holds a package.json, shallowest first. */
function candidateDirs(root) {
  const found = [];
  const walk = (dir, rel, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = join(dir, e.name);
      if (existsSync(join(childAbs, 'package.json'))) found.push({ dir: childAbs, rel: childRel });
      if (depth + 1 < MAX_DEPTH) walk(childAbs, childRel, depth + 1);
    }
  };
  walk(root, '', 0);
  return found;
}

/**
 * Find the packages a workspace root declares.
 *
 * Returns { globs, source, packages: [{ name, version, dir, rel, manifest, private }] }
 * sorted by name. Throws when the root declares no workspaces at all — being
 * told "this is not a workspace" is more useful than an empty pass.
 */
export function findWorkspacePackages(rootDir) {
  const root = resolve(rootDir);
  const manifest = readManifest(root);
  let globs = npmWorkspaceGlobs(manifest);
  let source = globs.length ? 'package.json' : null;
  if (!globs.length) {
    const pnpm = join(root, 'pnpm-workspace.yaml');
    const pnpmAlt = join(root, 'pnpm-workspace.yml');
    const file = existsSync(pnpm) ? pnpm : existsSync(pnpmAlt) ? pnpmAlt : null;
    if (file) {
      globs = pnpmWorkspaceGlobs(readFileSync(file, 'utf8'));
      if (globs.length) source = 'pnpm-workspace.yaml';
    }
  }
  if (!globs.length) {
    throw new Error(
      `no workspaces declared in ${join(root, 'package.json')} (and no pnpm-workspace.yaml) — ` +
        `drop --workspaces to prove this package on its own`
    );
  }

  const positive = globs.filter((g) => !g.startsWith('!')).map(globToRegExp);
  const negative = globs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)));

  const packages = [];
  const seen = new Set();
  for (const cand of candidateDirs(root)) {
    if (!positive.some((re) => re.test(cand.rel))) continue;
    if (negative.some((re) => re.test(cand.rel))) continue;
    let m;
    try {
      m = readManifest(cand.dir);
    } catch {
      continue; // a package.json we cannot parse is not a workspace package
    }
    if (!m.name) continue;
    if (seen.has(cand.dir)) continue;
    seen.add(cand.dir);
    packages.push({
      name: m.name,
      version: m.version || null,
      dir: cand.dir,
      rel: cand.rel,
      manifest: m,
      private: m.private === true,
    });
  }
  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { root, globs, source, packages };
}

/** The path to hand packproof for a package, relative to the process cwd. */
export function targetFor(pkgDir) {
  const rel = relative(process.cwd(), pkgDir);
  if (!rel) return '.';
  return rel.split(sep).join('/');
}

/**
 * The dependencies of `manifest` that are other packages in the same
 * workspace. These are the ones a clean room cannot get from the checkout.
 */
export function siblingDependencies(manifest, siblingNames) {
  const out = [];
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = manifest && manifest[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, range] of Object.entries(deps)) {
      if (!siblingNames.has(name)) continue;
      out.push({ name, range: String(range), field, protocol: /^workspace:/.test(String(range)) });
    }
  }
  return out;
}

/**
 * Was this install failure caused by a sibling workspace package rather than by
 * a genuinely missing dependency? Called only when the install already failed.
 */
export function siblingInstallFailure(stderr, siblingDeps) {
  if (!siblingDeps || !siblingDeps.length) return null;
  const text = String(stderr || '');
  if (/EUNSUPPORTEDPROTOCOL|Unsupported URL Type "workspace:/.test(text)) {
    const guilty = siblingDeps.filter((d) => d.protocol);
    if (guilty.length) return guilty;
  }
  const named = siblingDeps.filter((d) => text.includes(d.name));
  return named.length ? named : null;
}
