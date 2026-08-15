import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion,
  compareVersions,
  formatVersion,
  parseRange,
  satisfiesRange,
  floorOf,
  chooseInterpreter,
  whyUnsatisfied,
  classifyEngines,
  checkEngines,
  discoverInterpreters,
  classifyNodeRequest,
  resolveNodeRequests,
  nodeVersionOf,
  classifyRequestedNode,
} from '../src/engines.js';

const v = (s) => parseVersion(s);
const sat = (version, range) => satisfiesRange(v(version), parseRange(range));
const floor = (range) => formatVersion(floorOf(parseRange(range)));
const interp = (...versions) =>
  versions.map((s) => ({ path: `/nodes/${s}/bin/node`, version: v(s), running: false }));

test('parseVersion reads full, partial and prefixed versions', () => {
  assert.deepEqual(v('v18.20.4'), { major: 18, minor: 20, patch: 4 });
  assert.deepEqual(v('18'), { major: 18, minor: 0, patch: 0 });
  assert.deepEqual(v('18.2'), { major: 18, minor: 2, patch: 0 });
  assert.equal(v('lts/hydrogen'), null);
  assert.equal(v(''), null);
});

test('compareVersions orders by major then minor then patch', () => {
  assert.ok(compareVersions(v('18.0.0'), v('20.0.0')) < 0);
  assert.ok(compareVersions(v('18.20.4'), v('18.3.0')) > 0);
  assert.equal(compareVersions(v('18.1.1'), v('18.1.1')), 0);
});

test('>= is the common case and means every version above the floor', () => {
  assert.equal(sat('18.0.0', '>=18'), true);
  assert.equal(sat('22.3.1', '>=18'), true);
  assert.equal(sat('16.20.0', '>=18'), false);
  assert.equal(floor('>=18'), '18.0.0');
  assert.equal(floor('>=18.17.0'), '18.17.0');
});

test('a two-sided range accepts inside and rejects outside', () => {
  assert.equal(sat('20.1.0', '>=18 <21'), true);
  assert.equal(sat('21.0.0', '>=18 <21'), false);
  assert.equal(sat('17.9.0', '>=18 <21'), false);
  assert.equal(floor('>=18 <21'), '18.0.0');
});

test('caret, tilde, bare and x-ranges pin a major or a minor', () => {
  assert.equal(sat('18.20.4', '^18.0.0'), true);
  assert.equal(sat('19.0.0', '^18.0.0'), false);
  assert.equal(sat('18.2.9', '~18.2'), true);
  assert.equal(sat('18.3.0', '~18.2'), false);
  assert.equal(sat('18.99.0', '18.x'), true);
  assert.equal(sat('19.0.0', '18'), false);
  assert.equal(floor('^18.12.0'), '18.12.0');
});

test('|| unions alternatives and the floor is the lowest of them', () => {
  assert.equal(sat('16.4.0', '16 || 18 || 20'), true);
  assert.equal(sat('17.0.0', '16 || 18 || 20'), false);
  assert.equal(sat('20.11.1', '16 || 18 || 20'), true);
  assert.equal(floor('16 || 18 || 20'), '16.0.0');
  assert.equal(floor('^20 || >=18.17'), '18.17.0');
});

test('a hyphen range reads left to right', () => {
  assert.equal(sat('19.0.0', '18 - 20'), true);
  assert.equal(sat('20.9.0', '18 - 20'), true);
  assert.equal(sat('21.0.0', '18 - 20'), false);
  assert.equal(floor('18 - 20'), '18.0.0');
});

test('> excludes the whole partial version it names', () => {
  assert.equal(sat('18.20.4', '>18'), false);
  assert.equal(sat('19.0.0', '>18'), true);
  assert.equal(sat('18.2.1', '>18.2.1'), false);
  assert.equal(sat('18.2.2', '>18.2.1'), true);
});

test('* and an empty range accept anything and have no floor', () => {
  assert.equal(parseRange('*').any, true);
  assert.equal(parseRange('').any, true);
  assert.equal(sat('4.0.0', '*'), true);
  assert.equal(floor('*'), null);
});

test('a range packproof cannot read is marked unreadable, never guessed', () => {
  const parsed = parseRange('lts/hydrogen');
  assert.equal(parsed.readable, false);
  assert.equal(satisfiesRange(v('18.0.0'), parsed), null);
  assert.equal(floorOf(parsed), null);
});

test('chooseInterpreter takes the lowest node the range accepts', () => {
  const parsed = parseRange('>=18');
  const chosen = chooseInterpreter(interp('22.3.0', '18.20.4', '20.11.0'), parsed, floorOf(parsed));
  assert.equal(formatVersion(chosen.version), '18.20.4');
  assert.equal(chosen.atFloor, true);
});

test('chooseInterpreter marks a node above the floor major as not at the floor', () => {
  const parsed = parseRange('>=18');
  const chosen = chooseInterpreter(interp('22.3.0', '20.11.0'), parsed, floorOf(parsed));
  assert.equal(formatVersion(chosen.version), '20.11.0');
  assert.equal(chosen.atFloor, false);
});

test('chooseInterpreter returns null when nothing installed satisfies the range', () => {
  const parsed = parseRange('>=24');
  assert.equal(chooseInterpreter(interp('22.3.0', '18.20.4'), parsed, floorOf(parsed)), null);
});

test('whyUnsatisfied names the reason an old node refused the package', () => {
  assert.match(whyUnsatisfied("Error: No such built-in module: node:sqlite"), /builtin module/);
  assert.match(whyUnsatisfied("SyntaxError: Unexpected token '??='"), /cannot parse the syntax/);
  assert.match(whyUnsatisfied('TypeError: structuredClone is not a function'), /an API that Node version does not have/);
  assert.equal(whyUnsatisfied('something else entirely'), null);
});

test('a package that imports under its floor node passes and says which node', () => {
  const chk = classifyEngines({
    range: '>=18',
    interpreters: interp('18.20.4', '22.3.0'),
    probe: { ok: true, stderr: '', specifier: 'pkg' },
    running: 'v22.3.0',
  });
  assert.equal(chk.pass, true);
  assert.equal(chk.node, '18.20.4');
  assert.match(chk.note, /imported under node v18\.20\.4/);
  assert.match(chk.note, /oldest/);
});

test('a package that fails under its floor node fails as engines-unsatisfied', () => {
  const chk = classifyEngines({
    range: '>=18',
    interpreters: interp('18.20.4'),
    probe: { ok: false, stderr: 'Error: No such built-in module: node:sqlite', specifier: 'pkg' },
    running: 'v22.3.0',
  });
  assert.equal(chk.pass, false);
  assert.equal(chk.kind, 'engines-unsatisfied');
  assert.equal(chk.node, '18.20.4');
  assert.match(chk.hint, /node 18 and up/);
  assert.match(chk.hint, /builtin module/);
  assert.match(chk.hint, /installs this and it does not load/);
  assert.match(chk.detail, /node:sqlite/);
});

test('no node the range accepts: it passes but says it verified nothing', () => {
  const chk = classifyEngines({
    range: '>=18',
    interpreters: interp('16.20.0'),
    probe: null,
    running: 'v16.20.0',
  });
  assert.equal(chk.pass, true);
  assert.equal(chk.kind, 'engines-unverified');
  assert.match(chk.note, /did not verify/);
  assert.match(chk.note, /excluded by it/);
});

test('an unverifiable claim mentions the node everything else ran under', () => {
  const chk = classifyEngines({
    range: '>=18',
    interpreters: interp('22.3.0'),
    probe: null,
    running: 'v22.3.0',
  });
  // 22 satisfies >=18, so it is chosen — but it is not the floor.
  assert.equal(chk.pass, true);
  assert.match(chk.note, /node v22\.3\.0/);
});

test('verified above the floor says the floor itself is still unverified', () => {
  const chk = classifyEngines({
    range: '>=18',
    interpreters: interp('22.3.0'),
    probe: { ok: true, stderr: '', specifier: 'pkg' },
    running: 'v22.3.0',
  });
  assert.equal(chk.pass, true);
  assert.equal(chk.kind, 'engines-partly-verified');
  assert.match(chk.note, /no node 18 on this machine/);
  assert.match(chk.note, /floor itself is still unverified/);
});

test('a range packproof cannot read passes with a note that says so', () => {
  const chk = classifyEngines({ range: 'lts/*', interpreters: interp('22.3.0'), running: 'v22.3.0' });
  assert.equal(chk.pass, true);
  assert.equal(chk.kind, 'engines-unverified');
  assert.match(chk.note, /does not understand this range/);
});

test('a range that accepts anything has nothing to verify', () => {
  const chk = classifyEngines({ range: '*', interpreters: interp('22.3.0'), running: 'v22.3.0' });
  assert.equal(chk.pass, true);
  assert.equal(chk.kind, undefined);
  assert.match(chk.note, /nothing to verify/);
});

test('the check name quotes the range the manifest actually wrote', () => {
  assert.equal(
    classifyEngines({ range: '>=18.17.0', interpreters: [], running: 'v22.3.0' }).name,
    'engines.node ">=18.17.0"'
  );
});

test('no engines.node means no check at all — nothing was promised', () => {
  assert.deepEqual(checkEngines({ dir: '/nowhere' }, { name: 'p', version: '1.0.0' }), []);
  assert.deepEqual(checkEngines({ dir: '/nowhere' }, { name: 'p', engines: {} }), []);
  assert.deepEqual(checkEngines({ dir: '/nowhere' }, { name: 'p', engines: { node: '  ' } }), []);
});

test('checkEngines does not run anything when no interpreter satisfies the range', () => {
  const checks = checkEngines(
    { dir: '/nowhere' },
    { name: 'p', version: '1.0.0', main: 'index.js', engines: { node: '>=99' } },
    { interpreters: interp('22.3.0') }
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].pass, true);
  assert.equal(checks[0].kind, 'engines-unverified');
});

test('discoverInterpreters always includes the node packproof is running as', () => {
  // No version-manager directory exists under these paths, so the running Node
  // is the only thing there is to find. (A real machine may well have more —
  // GitHub's runners keep one under /usr/local/n — which is the point.)
  const found = discoverInterpreters({
    env: { NVM_DIR: '/nonexistent-nvm', N_PREFIX: '/nonexistent-n' },
    home: '/nonexistent-home',
    execPath: '/usr/bin/node',
    running: 'v20.1.2',
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].running, true);
  assert.equal(found[0].path, '/usr/bin/node');
  assert.equal(formatVersion(found[0].version), '20.1.2');
});

test('discoverInterpreters lists the running node first and never twice', () => {
  const found = discoverInterpreters();
  assert.equal(found[0].running, true);
  assert.equal(formatVersion(found[0].version), formatVersion(parseVersion(process.version)));
  const versions = found.map((f) => formatVersion(f.version));
  assert.equal(new Set(versions).size, versions.length);
});

test('the runner really launches the interpreter it chose, not the current one', async () => {
  const { createCleanRoom } = await import('../src/cleanroom.js');
  const room = createCleanRoom();
  try {
    // /bin/false is not node: whatever it is handed, it exits nonzero. If the
    // runner ignored `path` and used process.execPath, the import would succeed
    // and this check would pass — so a failure here is the proof.
    const checks = checkEngines(
      room,
      { name: 'nothing-installed', version: '1.0.0', main: 'index.js', engines: { node: '>=18' } },
      { interpreters: [{ path: '/bin/false', version: parseVersion('18.20.4'), running: false }] }
    );
    assert.equal(checks.length, 1);
    assert.equal(checks[0].pass, false);
    assert.equal(checks[0].kind, 'engines-unsatisfied');
    assert.equal(checks[0].node, '18.20.4');
  } finally {
    room.cleanup();
  }
});

// --- --node -----------------------------------------------------------------

const req = (s) => classifyNodeRequest(s);
const okProbe = { ok: true, stderr: '', specifier: null };
const failProbe = (stderr = "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:test") => ({
  ok: false,
  stderr,
  specifier: 'pkg',
});
const asked = (version, requested = version) => ({ path: `/nodes/${version}/bin/node`, version: v(version), requested });

test('classifyNodeRequest tells a version from a path', () => {
  assert.equal(req('18').kind, 'version');
  assert.equal(req('v18.20.4').kind, 'version');
  assert.equal(req('18.20').kind, 'version');
  assert.equal(req('/usr/local/bin/node').kind, 'path');
  assert.equal(req('./vendor/node').kind, 'path');
  assert.equal(req('lts/hydrogen').kind, 'path'); // not a version: it gets tried as a path, and says so
  assert.equal(req('').kind, 'empty');
  assert.equal(req(undefined).kind, 'empty');
});

test('a bare --node version resolves to the lowest installed node of that version', () => {
  const r = resolveNodeRequests([req('18')], { interpreters: interp('22.3.0', '18.20.4', '18.9.0') });
  assert.equal(r.ok, true);
  assert.equal(r.nodes.length, 1);
  assert.equal(formatVersion(r.nodes[0].version), '18.9.0');
  assert.equal(r.nodes[0].requested, '18');
});

test('a fully qualified --node version must match exactly', () => {
  const list = interp('18.20.4', '18.9.0');
  assert.equal(formatVersion(resolveNodeRequests([req('18.20.4')], { interpreters: list }).nodes[0].version), '18.20.4');
  const miss = resolveNodeRequests([req('18.20.3')], { interpreters: list });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /--node 18\.20\.3: no node 18\.20\.3 is installed/);
  assert.match(miss.error, /18\.9\.0, 18\.20\.4/, 'it names what it did find');
});

test('an empty --node is refused with a message that says what the flag takes', () => {
  const r = resolveNodeRequests([req('')], { interpreters: interp('22.3.0') });
  assert.equal(r.ok, false);
  assert.match(r.error, /--node needs a value/);
  assert.match(r.error, /18\.20\.4/);
});

test('a --node path that cannot be run is an error naming the reason', () => {
  const r = resolveNodeRequests([req('/nope/node')], {
    interpreters: interp('22.3.0'),
    probed: new Map([['/nope/node', { ok: false, error: 'ENOENT' }]]),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /--node \/nope\/node: packproof could not run it \(ENOENT\)/);
});

test('a --node path that runs but is not node is an error quoting what it printed', () => {
  const r = resolveNodeRequests([req('/bin/ls')], {
    interpreters: [],
    probed: new Map([['/bin/ls', { ok: true, output: 'ls (GNU coreutils) 9.1', version: null }]]),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /is not a node version/);
  assert.match(r.error, /ls \(GNU coreutils\) 9\.1/);
});

test('the same interpreter named twice is run once', () => {
  const list = interp('18.20.4');
  const r = resolveNodeRequests([req('18'), req('18.20.4'), req('/nodes/18.20.4/bin/node')], {
    interpreters: list,
    probed: new Map([['/nodes/18.20.4/bin/node', { ok: true, output: 'v18.20.4', version: v('18.20.4') }]]),
  });
  assert.equal(r.ok, true);
  assert.equal(r.nodes.length, 1);
});

test('nodeVersionOf reads the version of a real node binary', () => {
  const got = nodeVersionOf(process.execPath);
  assert.equal(got.ok, true);
  assert.equal(formatVersion(got.version), formatVersion(parseVersion(process.version)));
  assert.equal(nodeVersionOf('/definitely/not/here/node').ok, false);
});

test('a requested node inside the range that imports cleanly passes, and says if it is the floor', () => {
  const atFloor = classifyRequestedNode({ range: '>=18', node: asked('18.20.4'), probe: okProbe });
  assert.equal(atFloor.pass, true);
  assert.equal(atFloor.kind, undefined);
  assert.match(atFloor.name, /engines\.node ">=18" on node v18\.20\.4/);
  assert.match(atFloor.note, /oldest version this range claims/);

  const above = classifyRequestedNode({ range: '>=18', node: asked('22.3.0'), probe: okProbe });
  assert.equal(above.pass, true);
  assert.match(above.note, /floor of node 18 is not what ran/);
});

test('a requested node inside the range that fails to import is the package failing', () => {
  const c = classifyRequestedNode({ range: '>=18', node: asked('18.20.4'), probe: failProbe() });
  assert.equal(c.pass, false);
  assert.equal(c.kind, 'engines-unsatisfied');
  assert.match(c.hint, /builtin module that Node version does not have/);
  assert.match(c.hint, /Anyone on node v18\.20\.4 installs this/);
  assert.equal(c.node, '18.20.4');
});

test('a requested node the range excludes is reported, not failed — both ways round', () => {
  const worked = classifyRequestedNode({ range: '>=18', node: asked('16.20.2', '16'), probe: okProbe });
  assert.equal(worked.pass, true, 'the package never promised node 16 either way');
  assert.equal(worked.kind, 'engines-outside-range');
  assert.match(worked.note, /you asked for --node 16, and engines\.node ">=18" does not accept it/);
  assert.match(worked.note, /floor you declare may be higher/);

  const broke = classifyRequestedNode({ range: '>=18', node: asked('16.20.2', '16'), probe: failProbe() });
  assert.equal(broke.pass, true, 'engines.node already excluded it: this is an answer, not a charge');
  assert.equal(broke.kind, 'engines-outside-range');
  assert.match(broke.note, /does not accept/);
  assert.match(broke.note, /fails because it imports a builtin/);
  assert.match(broke.note, /Not counted against the package/);
});

test('with nothing declared in engines.node, a requested node that fails IS a failure', () => {
  const c = classifyRequestedNode({ range: null, node: asked('16.20.2', '16'), probe: failProbe() });
  assert.equal(c.pass, false);
  assert.equal(c.kind, 'engines-unsatisfied');
  assert.match(c.hint, /engines\.node declares nothing/);
  assert.match(c.hint, /Declare a floor/);
  assert.match(c.name, /node v16\.20\.2, which nothing declares/);

  const fine = classifyRequestedNode({ range: null, node: asked('16.20.2', '16'), probe: okProbe });
  assert.equal(fine.pass, true);
  assert.match(fine.note, /proves more than the manifest claims/);
});

test('an unreadable range never blames the package for a node it cannot classify', () => {
  const c = classifyRequestedNode({ range: 'lts/*', node: asked('16.20.2', '16'), probe: failProbe() });
  assert.equal(c.pass, true);
  assert.equal(c.kind, 'engines-unverified');
  assert.match(c.note, /cannot read "lts\/\*"/);
});

test('a requested node with nothing to import verifies nothing, and says so', () => {
  const c = classifyRequestedNode({ range: '>=18', node: asked('18.20.4'), probe: null });
  assert.equal(c.pass, true);
  assert.equal(c.kind, 'engines-unverified');
  assert.match(c.note, /nothing to import/);
});

test('--node replaces the automatic choice, and works with no engines.node at all', async () => {
  const { createCleanRoom } = await import('../src/cleanroom.js');
  const room = createCleanRoom();
  try {
    // /bin/false stands in for a node that cannot load the package: if the
    // runner had used the automatic choice (the running node) instead of the
    // one asked for, the import would have succeeded.
    const nodes = [{ path: '/bin/false', version: parseVersion('16.20.2'), requested: '16' }];
    const declared = checkEngines(room, { name: 'p', version: '1.0.0', main: 'index.js', engines: { node: '>=18' } }, { nodes });
    assert.equal(declared.length, 1);
    assert.equal(declared[0].pass, true, 'node 16 is outside >=18');
    assert.equal(declared[0].kind, 'engines-outside-range');

    const undeclared = checkEngines(room, { name: 'p', version: '1.0.0', main: 'index.js' }, { nodes });
    assert.equal(undeclared.length, 1, 'no engines.node, but the caller still asked a question');
    assert.equal(undeclared[0].pass, false);

    const two = checkEngines(
      room,
      { name: 'p', version: '1.0.0', main: 'index.js', engines: { node: '>=18' } },
      { nodes: [nodes[0], { path: '/bin/false', version: parseVersion('18.20.4'), requested: '18' }] }
    );
    assert.equal(two.length, 2, 'one check per interpreter asked for');
    assert.equal(two[1].pass, false, 'node 18 is inside >=18, so failing there is the package failing');
  } finally {
    room.cleanup();
  }
});
