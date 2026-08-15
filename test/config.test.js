// packproof.json: the lane a repo settled on, written down once.
//
// What these defend, in order of how much it would cost to get wrong:
//   1. a flag always beats the file,
//   2. a run that used a file says so, and says what it said,
//   3. a key packproof does not know is an error, not a shrug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, mergeConfig, configSummary, CONFIG_KEYS, CONFIG_FILENAME } from '../src/config.js';

const parse = (obj, opts) => parseConfig(typeof obj === 'string' ? obj : JSON.stringify(obj), opts);

test('the filename is packproof.json', () => {
  assert.equal(CONFIG_FILENAME, 'packproof.json');
});

test('a lane parses into the same shape the CLI produces', () => {
  const r = parse({ skip: ['install'], node: ['18', '20'], lazy: true, binArgs: ['--help'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { skip: ['install'], node: ['18', '20'], lazy: true, binArgs: ['--help'] });
});

test('a string is accepted wherever a list is, because --only entries is a string', () => {
  const r = parse({ only: 'entries', skip: 'install,bins', node: '18' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.only, ['entries']);
  assert.deepEqual(r.config.skip, ['install,bins'], 'commas stay for parseCheckList to split');
  assert.deepEqual(r.config.node, ['18']);
});

test('binArgs as a string splits on spaces the way --bin-args does', () => {
  const r = parse({ binArgs: '--version --json' });
  assert.deepEqual(r.config.binArgs, ['--version', '--json']);
});

test('an unknown key is an error naming the real ones', () => {
  const r = parse({ stict: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /^packproof\.json: unknown key "stict"/);
  for (const key of Object.keys(CONFIG_KEYS)) assert.ok(r.error.includes(key), `error should list ${key}`);
});

test('a near-miss key is named, not just rejected', () => {
  for (const [written, meant] of [['bin-args', 'binArgs'], ['ignore_scripts', 'ignoreScripts'], ['RegistryUrl', 'registryUrl']]) {
    const r = parse({ [written]: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(`unknown key "${written}" — did you mean "${meant}"\\?`));
  }
});

test('a per-invocation flag is not a repo setting, and says so by being unknown', () => {
  for (const key of ['registry', 'out', 'keep', 'workspace', 'target']) {
    const r = parse({ [key]: 'x' });
    assert.equal(r.ok, false, `${key} must not be a config key`);
    assert.match(r.error, /unknown key/);
  }
});

test('a wrong type is an error that says what the right one is', () => {
  assert.match(parse({ lazy: 'yes' }).error, /"lazy" must be true or false, got "yes"/);
  assert.match(parse({ strict: 1 }).error, /"strict" must be true or false, got 1/);
  assert.match(parse({ only: [1, 2] }).error, /"only" must be a string or an array of strings/);
  assert.match(parse({ registryUrl: ['a'] }).error, /"registryUrl" must be a string/);
});

test('an unknown format is caught in the file, not three seconds later', () => {
  const r = parse({ format: 'yaml' });
  assert.equal(r.ok, false);
  assert.match(r.error, /"format" is "yaml" — pick one of human, json, github, junit/);
  assert.equal(parse({ format: 'junit' }).ok, true);
});

test('an empty list is an error rather than a setting that does nothing', () => {
  assert.match(parse({ skip: [] }).error, /"skip" is empty/);
  assert.match(parse({ only: ['entries', '  '] }).error, /"only" contains an empty entry/);
});

test('not-an-object and not-JSON are both named for what they are', () => {
  assert.match(parse('[1,2]').error, /expected a JSON object, got an array/);
  assert.match(parse('"lane"').error, /expected a JSON object, got "lane"/);
  assert.match(parse('{nope').error, /not valid JSON —/);
  assert.match(parse('null').error, /expected a JSON object, got null/);
});

test('$schema and // are editor plumbing, not settings', () => {
  const r = parse({ $schema: 'https://example.com/s.json', '//': 'our release lane', strict: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { strict: true });
});

test('the source name in an error is the file that was actually read', () => {
  const r = parse({ nope: 1 }, { source: 'ci/lane.json' });
  assert.match(r.error, /^ci\/lane\.json: unknown key "nope"/);
});

test('a flag always beats the file', () => {
  const { config } = parse({ skip: ['install'], lazy: true, format: 'json' });
  const cli = { skip: ['bins'], format: 'github' };
  const m = mergeConfig(config, cli, new Set(['skip', 'format']));
  assert.deepEqual(m.opts.skip, ['bins'], 'the flag wins outright');
  assert.equal(m.opts.format, 'github');
  assert.equal(m.opts.lazy, true, 'a key no flag touched still comes from the file');
  assert.deepEqual(m.overridden, ['skip', 'format']);
  assert.deepEqual(m.applied, [{ key: 'lazy', value: true }]);
});

test('lists are replaced by the flag, never concatenated with the file', () => {
  const { config } = parse({ skip: ['install', 'bins'] });
  const m = mergeConfig(config, { skip: ['engines'] }, new Set(['skip']));
  assert.deepEqual(m.opts.skip, ['engines']);
});

test('a false in the file is a setting, not an absence', () => {
  const { config } = parse({ lazy: false });
  const m = mergeConfig(config, {}, new Set());
  assert.equal(m.opts.lazy, false);
  assert.deepEqual(m.applied, [{ key: 'lazy', value: false }]);
});

test('merging touches nothing the config did not mention', () => {
  const cli = { target: '.', binArgs: ['--version'] };
  const m = mergeConfig({ strict: true }, cli, new Set());
  assert.equal(m.opts.target, '.');
  assert.deepEqual(m.opts.binArgs, ['--version']);
  assert.deepEqual(cli, { target: '.', binArgs: ['--version'] }, 'the caller\'s object is not mutated');
});

test('merge accepts a plain object for provided, not only a Set', () => {
  const m = mergeConfig({ strict: true }, { strict: false }, { strict: true });
  assert.equal(m.opts.strict, false);
});

test('the summary line names the file and what it said', () => {
  const { config } = parse({ skip: 'install', node: ['18', '20'] });
  const m = mergeConfig(config, {}, new Set());
  assert.equal(
    configSummary({ path: 'packproof.json', ...m }),
    'config — packproof.json: skip=install, node=18,20'
  );
});

test('the summary line admits which settings a flag beat', () => {
  const { config } = parse({ skip: 'install', strict: true });
  const m = mergeConfig(config, { strict: false }, new Set(['strict']));
  assert.equal(
    configSummary({ path: 'ci/lane.json', ...m }),
    'config — ci/lane.json: skip=install (flags override strict)'
  );
});

test('a file every flag beat still prints, because it was still read', () => {
  const { config } = parse({ strict: true });
  const m = mergeConfig(config, { strict: false }, new Set(['strict']));
  assert.equal(configSummary({ path: 'packproof.json', ...m }), 'config — packproof.json: every setting overridden by flags (strict)');
});

test('an empty config file still prints, so the reader knows it was found', () => {
  const { config } = parse({});
  const m = mergeConfig(config, {}, new Set());
  assert.equal(configSummary({ path: 'packproof.json', ...m }), 'config — packproof.json: no settings');
});

test('no config file means no line at all: a run without one is unchanged', () => {
  assert.equal(configSummary(null), null);
  assert.equal(configSummary({}), null);
});

test('every documented key round-trips through parse and merge', () => {
  const sample = {
    only: ['entries'], skip: ['bins'], node: ['18'], binArgs: ['--v'],
    lazy: true, strict: true, ignoreScripts: true, workspaces: true,
    includePrivate: true, diff: true, format: 'json', registryUrl: 'https://r.example',
  };
  assert.deepEqual(Object.keys(sample).sort(), Object.keys(CONFIG_KEYS).sort(), 'a new key needs a test');
  const r = parse(sample);
  assert.equal(r.ok, true, r.error);
  const m = mergeConfig(r.config, {}, new Set());
  for (const [k, v] of Object.entries(sample)) assert.deepEqual(m.opts[k], v, `${k} did not survive`);
});
