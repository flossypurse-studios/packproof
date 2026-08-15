// The peers check, tested where it can be tested honestly: the classification
// is pure, so it gets pinned here without an npm install anywhere in sight.
// The one thing that needs a real clean room — an "optional" peer that isn't —
// lives in fixtures.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  declaredPeers,
  describePeers,
  peerSummaryCheck,
  peerRoomFailureCheck,
  classifyPeerProbe,
  checkPeers,
} from '../src/peers.js';

const notFound = (pkg) =>
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '${pkg}' imported from /tmp/room/node_modules/thing/index.js`;

test('declaredPeers reads the range and the optional flag', () => {
  const peers = declaredPeers({
    peerDependencies: { react: '^18', '@types/node': '*' },
    peerDependenciesMeta: { '@types/node': { optional: true } },
  });
  assert.deepEqual(peers, [
    { name: 'react', range: '^18', optional: false },
    { name: '@types/node', range: '*', optional: true },
  ]);
});

test('declaredPeers is empty and harmless for a manifest with no peers', () => {
  assert.deepEqual(declaredPeers({}), []);
  assert.deepEqual(declaredPeers({ peerDependencies: null }), []);
  assert.deepEqual(declaredPeers({ peerDependencies: {}, peerDependenciesMeta: 'nonsense' }), []);
});

test('describePeers marks which ones claim to be optional', () => {
  assert.equal(
    describePeers(declaredPeers({
      peerDependencies: { a: '^1', b: '^2' },
      peerDependenciesMeta: { b: { optional: true } },
    })),
    'a@^1, b@^2 (optional)'
  );
});

test('with no peers the summary says so and claims nothing else', () => {
  const c = peerSummaryCheck([]);
  assert.equal(c.pass, true);
  assert.match(c.note, /none declared/);
});

test('the summary names the peers without promising a second room was built', () => {
  const c = peerSummaryCheck(declaredPeers({ peerDependencies: { react: '^18' } }));
  assert.equal(c.pass, true);
  assert.match(c.note, /react@\^18/);
  assert.doesNotMatch(c.note, /installed/);
});

test('an entry point that loads with the peers absent just passes', () => {
  const peers = declaredPeers({ peerDependencies: { react: '^18' } });
  const c = classifyPeerProbe({ spec: 'thing', ok: true, stderr: '' }, peers);
  assert.equal(c.pass, true);
  assert.match(c.name, /with peers absent/);
  assert.equal(c.note, undefined);
});

test('an entry point that needs a REQUIRED peer passes, with a note naming it', () => {
  const peers = declaredPeers({ peerDependencies: { react: '^18' } });
  const c = classifyPeerProbe({ spec: 'thing', ok: false, stderr: notFound('react') }, peers);
  // A required peer is the consumer's job by definition. Failing here would be
  // packproof punishing a package for meaning what it said.
  assert.equal(c.pass, true);
  assert.match(c.note, /"react" at load time/);
  assert.match(c.note, /pnpm and yarn 1 do not/);
});

test('an entry point that needs an OPTIONAL peer is a failure', () => {
  const peers = declaredPeers({
    peerDependencies: { react: '^18' },
    peerDependenciesMeta: { react: { optional: true } },
  });
  const c = classifyPeerProbe({ spec: 'thing', ok: false, stderr: notFound('react') }, peers);
  assert.equal(c.pass, false);
  assert.equal(c.kind, 'optional-peer-required');
  assert.equal(c.missing, 'react');
  assert.match(c.hint, /marked optional/);
  assert.match(c.hint, /crash on import/);
});

test('a subpath import is attributed to the package it belongs to', () => {
  const peers = declaredPeers({
    peerDependencies: { '@scope/ui': '^1' },
    peerDependenciesMeta: { '@scope/ui': { optional: true } },
  });
  const c = classifyPeerProbe({ spec: 'thing', ok: false, stderr: notFound('@scope/ui/button') }, peers);
  assert.equal(c.kind, 'optional-peer-required');
  assert.equal(c.missing, '@scope/ui');
});

test('a missing package that is nobody\'s declared peer is a note, not a verdict', () => {
  // --legacy-peer-deps also drops the peers of your dependencies, and those are
  // not this package's promise to keep.
  const peers = declaredPeers({ peerDependencies: { react: '^18' } });
  const c = classifyPeerProbe({ spec: 'thing', ok: false, stderr: notFound('some-transitive-peer') }, peers);
  assert.equal(c.pass, true);
  assert.match(c.note, /not a peer this package declares/);
  assert.match(c.note, /Not counted against you/);
});

test('an unattributable crash in the peer-free room is not counted either', () => {
  const peers = declaredPeers({ peerDependencies: { react: '^18' } });
  const c = classifyPeerProbe({ spec: 'thing', ok: false, stderr: 'TypeError: boom' }, peers);
  assert.equal(c.pass, true);
  assert.match(c.note, /could not attribute/);
  assert.match(c.detail, /boom/);
});

test('a package already blamed in the first room is not blamed twice', () => {
  const peers = declaredPeers({
    peerDependencies: { react: '^18' },
    peerDependenciesMeta: { react: { optional: true } },
  });
  const c = classifyPeerProbe(
    { spec: 'thing', ok: false, stderr: notFound('react') },
    peers,
    new Set(['react'])
  );
  assert.equal(c, null);
});

test('a peer-free room that cannot be built is admitted, not invented', () => {
  const peers = declaredPeers({ peerDependencies: { react: '^18' } });
  const c = peerRoomFailureCheck(peers, 'npm ERR! code ETARGET\nnope');
  assert.equal(c.pass, true);
  assert.equal(c.kind, 'peer-room-unavailable');
  assert.match(c.note, /Nothing is claimed/);
  assert.match(c.detail, /ETARGET/);
});

test('no peerDependencies means no second install at all', () => {
  // The whole reason this check is affordable by default: the common case does
  // no work. If this ever tries to npm install, it will take far longer than 5s.
  const started = Date.now();
  const checks = checkPeers('/nonexistent.tgz', { name: 'thing', version: '1.0.0', main: 'index.js' });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].pass, true);
  assert.match(checks[0].note, /none declared/);
  assert.ok(Date.now() - started < 5000, 'it did not try to install anything');
});

test('peers declared but nothing importable means nothing to probe', () => {
  // No exports/main/module: there is no entry point to load with or without a
  // peer, so the summary stands alone rather than a room being built for fun.
  const checks = checkPeers('/nonexistent.tgz', {
    name: 'thing',
    version: '1.0.0',
    peerDependencies: { react: '^18' },
  });
  assert.equal(checks.length, 1);
  assert.match(checks[0].note, /react@\^18/);
});
