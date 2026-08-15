import { makeTarball, readManifest, tarballFiles } from './pack.js';
import { createCleanRoom, installTarball } from './cleanroom.js';
import { checkEntries, checkRequire, checkBins } from './checks.js';
import { checkLazyImports } from './lazy.js';
import { checkShippedFiles } from './hygiene.js';
import { diffAgainstPublished } from './diff.js';
import { fetchRegistryTarball, manifestFromTarball, DEFAULT_REGISTRY } from './registry.js';
import { resolve, relative, sep } from 'node:path';
import {
  findWorkspacePackages,
  targetFor,
  siblingDependencies,
  siblingInstallFailure,
  releaseOrder,
} from './workspaces.js';

/**
 * Where the packed files live relative to the working directory, so a formatter
 * can turn a package-relative path like "src/a.js" into one CI can click on.
 * Empty string means "the working directory is the package root".
 */
function pathPrefixFor(target) {
  if (!target || target === '.') return '';
  if (/\.(tgz|tar\.gz)$/.test(target)) return '';
  const rel = relative(process.cwd(), resolve(process.cwd(), target));
  if (!rel || rel.startsWith('..')) return ''; // outside the checkout: don't pretend
  return rel.split(sep).join('/');
}

/**
 * Pack the project (or download an already-published version), install it into
 * a clean room, and prove it works. Returns a plain result object; the CLI does
 * all the printing.
 */
export async function packproof(target = '.', opts = {}) {
  const started = Date.now();
  opts = { ...opts, target };
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
  // What shipped is a fact about the release on its own: report it before the
  // install, so a leaked credential is still named even if nothing installs.
  checks.push(checkShippedFiles(files, { strict: opts.strict }));
  // What the last release shipped is the only honest baseline for what this one
  // should contain, and asking the registry costs one request. Before the install,
  // because it is a fact about the file list and needs nothing installed.
  let fileDiff = null;
  if (opts.diff) {
    const got = await diffAgainstPublished({
      manifest,
      files,
      diff: opts.diff,
      registryUrl: opts.registryUrl || DEFAULT_REGISTRY,
      currentVersion: manifest.version,
      strict: opts.strict,
    });
    checks.push(got.check);
    fileDiff = got.diff;
  }
  // Dependencies on other packages in the same workspace behave differently in
  // a clean room, so they are worth knowing about before the install runs.
  const siblingDeps = opts.siblingNames
    ? siblingDependencies(manifest, opts.siblingNames).filter((d) => d.name !== manifest.name)
    : [];
  const room = createCleanRoom();
  let install;
  try {
    install = installTarball(room, tarball, { ignoreScripts: opts.ignoreScripts });
    if (!install.ok) {
      const detail = (install.stderr || install.error || '').split('\n').slice(0, 5).join('\n').replace(/\s+$/, '');
      const guilty = siblingInstallFailure(install.stderr || install.error, siblingDeps);
      if (guilty) {
        // Not a missing dependency: a dependency that only exists in this
        // checkout. Saying "undeclared dependency" here would be a lie.
        const list = guilty.map((d) => `${d.name}@${d.range}`).join(', ');
        checks.push({
          name: 'npm install <tarball>',
          pass: false,
          kind: 'workspace-sibling-dependency',
          siblings: guilty.map((d) => d.name),
          hint:
            `depends on ${list}, ${guilty.length === 1 ? 'another package' : 'other packages'} in this ` +
            `workspace. A stranger installs from the registry, not from your checkout, so this tarball ` +
            `cannot be proved on its own until ${guilty.length === 1 ? 'that package is' : 'those packages are'} ` +
            `published at a version this range resolves to` +
            (guilty.some((d) => d.protocol)
              ? `. A workspace: range never resolves outside the workspace — npm pack leaves it in the tarball as-is, so publishing it would ship it.`
              : `.`),
          detail,
        });
      } else {
        checks.push({
          name: 'npm install <tarball>',
          pass: false,
          kind: 'install-failed',
          hint: 'the package could not even be installed into an empty project.',
          detail,
        });
      }
      return finish({ manifest, tarball, packed, files, checks, started, room, opts, source, registry, fileDiff });
    }
    checks.push({
      name: 'npm install <tarball>',
      pass: true,
      note: siblingDeps.length
        ? `${siblingDeps.map((d) => `${d.name}@${d.range}`).join(', ')} resolved from the registry, not from this workspace`
        : undefined,
    });
    checks.push(...checkEntries(room, manifest));
    if (!opts.skipRequire) checks.push(...checkRequire(room, manifest));
    checks.push(...checkBins(room, manifest, { binArgs: opts.binArgs, strict: opts.strict }));
    if (opts.lazy) {
      // Don't say the same thing twice: if loading already blew up on a package,
      // the deep probe has nothing to add about it.
      const already = new Set(checks.filter((c) => !c.pass && c.missing).map((c) => c.missing));
      checks.push(...checkLazyImports(room, manifest, files, { already }));
    }
  } finally {
    if (!opts.keep) room.cleanup();
  }
  return finish({ manifest, tarball, packed, files, checks, started, room, opts, source, registry, fileDiff });
}

function finish({ manifest, tarball, packed, files, checks, started, room, opts, source, registry, fileDiff }) {
  const failed = checks.filter((c) => !c.pass);
  return {
    name: manifest.name,
    version: manifest.version,
    source: source || 'local',
    pathPrefix: source === 'registry' ? null : pathPrefixFor(opts.target ?? null),
    registry: registry || null,
    diff: fileDiff || null,
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

/**
 * Prove every package in a workspace, each in its own clean room.
 *
 * One package's result is exactly the shape a single-package run returns, plus
 * `workspace` (its name) and `workspaceDir` (where it lives in the checkout),
 * so every formatter can keep using `pathPrefix` and get the right file.
 */
export async function packproofWorkspaces(target = '.', opts = {}) {
  const started = Date.now();
  const rootDir = resolve(process.cwd(), target === '.' ? '.' : target);
  const found = findWorkspacePackages(rootDir);
  if (!found.packages.length) {
    throw new Error(
      `${found.source} declares workspaces (${found.globs.join(', ')}) but no package matched them`
    );
  }

  const wanted = (opts.workspace || []).filter(Boolean);
  let selected = found.packages;
  if (wanted.length) {
    const known = (p) => wanted.includes(p.name) || wanted.includes(p.rel);
    const missing = wanted.filter((w) => !found.packages.some((p) => p.name === w || p.rel === w));
    if (missing.length) {
      throw new Error(
        `no workspace package named ${missing.join(', ')} — this workspace has ` +
          found.packages.map((p) => p.name).join(', ')
      );
    }
    selected = found.packages.filter(known);
  }

  const siblingNames = new Set(found.packages.map((p) => p.name));
  const packages = [];
  const skipped = [];
  for (const pkg of selected) {
    if (pkg.private && !opts.includePrivate) {
      // A private package is never published, so a stranger never installs it.
      skipped.push({ name: pkg.name, dir: pkg.rel, reason: 'private' });
      continue;
    }
    const one = await packproof(targetFor(pkg.dir), {
      ...opts,
      workspaces: false,
      workspace: null,
      siblingNames,
    });
    one.workspace = pkg.name;
    one.workspaceDir = pkg.rel;
    packages.push(one);
  }

  const failures = [];
  for (const p of packages) for (const f of p.failures) failures.push({ ...f, package: p.name });

  // The order to publish in is a property of the whole workspace, not of the
  // subset --workspace happened to select, so it is computed over every package
  // a stranger could install: the publishable ones.
  const orderable = found.packages.filter((p) => !p.private || opts.includePrivate);
  const order = releaseOrder(orderable);
  return {
    workspaces: true,
    root: targetFor(rootDir),
    rootName: found.packages.length ? readManifest(rootDir).name || null : null,
    workspaceSource: found.source,
    globs: found.globs,
    packages,
    packageCount: packages.length,
    releaseOrder: order,
    skipped,
    failures,
    ok: failures.length === 0,
    okCount: packages.filter((p) => p.ok).length,
    durationMs: Date.now() - started,
  };
}
