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
  const found = discoverInterpreters({ env: {}, home: '/nonexistent-home', execPath: '/usr/bin/node', running: 'v20.1.2' });
  assert.equal(found.length, 1);
  assert.equal(found[0].running, true);
  assert.equal(found[0].path, '/usr/bin/node');
  assert.equal(formatVersion(found[0].version), '20.1.2');
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
