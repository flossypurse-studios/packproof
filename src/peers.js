// The one dependency the clean room lies about.
//
// A peerDependency is a sentence addressed to the consumer: "you install this,
// not me." But npm 7+ auto-installs required peers, so packproof's clean room
// quietly ends up holding the very thing the consumer is supposed to provide —
// every import passes and the report never mentions it. Meanwhile npm does NOT
// auto-install a peer marked `peerDependenciesMeta.optional`, which is the
// opposite promise: "you may skip this." A package that says that and then
// imports the thing at load time hard-crashes for everyone who took it at its
// word — and the crash is invisible here only because the crash is real.
//
// So: build a second clean room with the peers genuinely absent
// (`npm install --legacy-peer-deps`) and re-import every entry point.
//   - fails without an OPTIONAL peer  -> a failure. The optional flag is false.
//   - fails without a REQUIRED peer   -> a pass with a note naming what the
//                                        consumer has to install, because that
//                                        is exactly what a peer means.
//   - fails on something nobody here declared as a peer -> a note, not a
//     verdict: --legacy-peer-deps also drops your dependencies' peers, and
//     that is not this package's promise to keep.
// If the peer-free room cannot be built at all, say so and pass. An invented
// verdict is worse than an admitted gap.

import { createCleanRoom, installTarball, runInRoom } from './cleanroom.js';
import { entrySpecifiers, missingSpecifier } from './checks.js';

/** The peers a manifest declares, each with whether it claims to be optional. */
export function declaredPeers(manifest = {}) {
  const peers = manifest.peerDependencies || {};
  if (!peers || typeof peers !== 'object') return [];
  const meta = (manifest.peerDependenciesMeta && typeof manifest.peerDependenciesMeta === 'object')
    ? manifest.peerDependenciesMeta
    : {};
  return Object.keys(peers).map((name) => ({
    name,
    range: String(peers[name] ?? ''),
    optional: !!(meta[name] && meta[name].optional),
  }));
}

/** `@scope/pkg/sub` and `pkg/sub` both belong to a package; find whose. */
function packageRoot(specifier) {
  if (!specifier) return '';
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

/** "a@^1, b@^2 (optional)" — how the peers get named in a note. */
export function describePeers(peers) {
  return peers.map((p) => `${p.name}@${p.range}${p.optional ? ' (optional)' : ''}`).join(', ');
}

/**
 * The headline check: what this package asks the consumer to install.
 * Always emitted when the peers check runs, so a report that says nothing about
 * peers is a report where there were none.
 */
export function peerSummaryCheck(peers) {
  if (!peers.length) {
    return {
      name: 'peerDependencies',
      pass: true,
      note: 'none declared, so there is nothing the consumer has to install alongside this package',
    };
  }
  // Describe, don't promise: whether the peer-free room actually got built is
  // the next check's business, and a note that assumed it would be a lie the
  // moment npm refuses.
  return {
    name: 'peerDependencies',
    pass: true,
    note: `${peers.length} declared, and the consumer installs ${peers.length === 1 ? 'it' : 'them'}: ${describePeers(peers)}`,
  };
}

/**
 * Classify one peer-free import probe.
 *
 * Pure: takes what happened, returns the check. `probe` is
 * `{ spec, ok, stderr }`; `peers` is the output of declaredPeers().
 */
export function classifyPeerProbe(probe, peers, already = new Set()) {
  const name = `import "${probe.spec}" with peers absent`;
  if (probe.ok) return { name, pass: true };

  const missing = missingSpecifier(probe.stderr || '');
  const root = packageRoot(missing || '');
  // Already named by a check that ran in the first room: saying it again in
  // different words would read as two problems where there is one.
  if (root && already.has(root)) return null;
  const peer = peers.find((p) => p.name === root);

  if (peer && peer.optional) {
    return {
      name,
      pass: false,
      kind: 'optional-peer-required',
      missing: peer.name,
      hint:
        `"${peer.name}" is marked optional in peerDependenciesMeta, but "${probe.spec}" cannot be loaded ` +
        `without it. Anyone who believes the manifest and skips it gets a crash on import, not a degraded ` +
        `feature. Either drop the optional flag, or move the import inside the code path that needs it.`,
      detail: firstLines(probe.stderr),
    };
  }
  if (peer) {
    return {
      name,
      pass: true,
      note:
        `needs "${peer.name}" at load time. That is a declared peer, so installing it is the consumer's ` +
        `job — npm 7+ does it automatically, pnpm and yarn 1 do not.`,
    };
  }
  if (missing) {
    return {
      name,
      pass: true,
      note:
        `did not load without peers because "${root}" was missing, and "${root}" is not a peer this package ` +
        `declares — most likely a peer of one of your dependencies. Not counted against you.`,
    };
  }
  return {
    name,
    pass: true,
    note: 'failed to load in the peer-free room for a reason packproof could not attribute to a peer, so it is not counted. Re-run with --keep to look.',
    detail: firstLines(probe.stderr),
  };
}

function firstLines(text, n = 5) {
  return (text || '').split('\n').slice(0, n).join('\n').replace(/\s+$/, '') || undefined;
}

/** The check emitted when the peer-free room could not be built. */
export function peerRoomFailureCheck(peers, reason) {
  return {
    name: 'clean room without peers',
    pass: true,
    kind: 'peer-room-unavailable',
    note:
      `could not install the tarball with --legacy-peer-deps, so this run never saw what happens without ` +
      `${describePeers(peers)}. Nothing is claimed about ${peers.length === 1 ? 'it' : 'them'}.`,
    detail: firstLines(reason),
  };
}

/**
 * Run the peers check. Builds and tears down its own clean room, and only when
 * there is something to learn: a package with no peerDependencies costs one
 * line of report and no install at all.
 */
export function checkPeers(tarball, manifest, { keep = false, ignoreScripts = false, already = new Set() } = {}) {
  const peers = declaredPeers(manifest);
  const checks = [peerSummaryCheck(peers)];
  if (!peers.length) return checks;

  const specs = entrySpecifiers(manifest);
  if (!specs.length) return checks;

  const room = createCleanRoom();
  try {
    const install = installTarball(room, tarball, { ignoreScripts, legacyPeerDeps: true });
    if (!install.ok) {
      checks.push(peerRoomFailureCheck(peers, install.stderr || install.error));
      return checks;
    }
    for (const spec of specs) {
      const r = runInRoom(room, `await import(${JSON.stringify(spec)});\nconsole.log('ok');\n`);
      const c = classifyPeerProbe({ spec, ok: r.ok, stderr: r.stderr }, peers, already);
      if (c) checks.push(c);
    }
    if (keep) checks[0].detail = `peer-free clean room kept at ${room.dir}`;
    return checks;
  } finally {
    if (!keep) room.cleanup();
  }
}
