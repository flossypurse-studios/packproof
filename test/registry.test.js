// --registry mode: prove an already-published tarball, not the local tree.
//
// The unit half needs no network. The end-to-end half stands up a throwaway
// HTTP server that speaks just enough of the npm registry protocol to serve a
// packument and a tarball, so the whole download → verify → clean-room path is
// exercised offline and deterministically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { packproof } from '../src/index.js';
import { makeTarball } from '../src/pack.js';
import {
  parseSpec,
  resolveVersion,
  distFor,
  verifyIntegrity,
  manifestFromTarball,
  fetchRegistryTarball,
} from '../src/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => join(here, 'fixtures', n);
const TIMEOUT = 180000;

test('parseSpec: bare name means the latest dist-tag', () => {
  assert.deepEqual(parseSpec('lodash'), { name: 'lodash', wanted: 'latest' });
});

test('parseSpec: name@version', () => {
  assert.deepEqual(parseSpec('lodash@4.17.21'), { name: 'lodash', wanted: '4.17.21' });
});

test('parseSpec: a scoped name is not mistaken for a version separator', () => {
  assert.deepEqual(parseSpec('@babel/core@7.0.0'), { name: '@babel/core', wanted: '7.0.0' });
  assert.deepEqual(parseSpec('@babel/core'), { name: '@babel/core', wanted: 'latest' });
});

test('parseSpec: a trailing @ is just "latest"', () => {
  assert.deepEqual(parseSpec('pkg@'), { name: 'pkg', wanted: 'latest' });
});

test('parseSpec: dist-tags are versions too', () => {
  assert.deepEqual(parseSpec('pkg@next'), { name: 'pkg', wanted: 'next' });
});

test('parseSpec: rejects things that are not package specs', () => {
  assert.throws(() => parseSpec(''), /expected/i);
  assert.throws(() => parseSpec('   '), /expected/i);
  assert.throws(() => parseSpec('./local/path'), /looks like a path/i);
  assert.throws(() => parseSpec('/tmp/x.tgz'), /looks like a path/i);
  assert.throws(() => parseSpec('not/scoped'), /scoped/i);
  assert.throws(() => parseSpec('https://x/y.tgz'), /looks like a/i);
});

const packument = {
  name: 'demo',
  'dist-tags': { latest: '2.0.0', next: '3.0.0-beta.1' },
  versions: {
    '1.0.0': { version: '1.0.0', dist: { tarball: 'http://r/demo-1.0.0.tgz' } },
    '2.0.0': { version: '2.0.0', dist: { tarball: 'http://r/demo-2.0.0.tgz', integrity: 'sha512-x' } },
    '3.0.0-beta.1': { version: '3.0.0-beta.1', dist: { tarball: 'http://r/demo-3.tgz' } },
  },
};

test('resolveVersion: a dist-tag resolves to its version', () => {
  assert.equal(resolveVersion(packument, 'latest'), '2.0.0');
  assert.equal(resolveVersion(packument, 'next'), '3.0.0-beta.1');
});

test('resolveVersion: an exact version resolves to itself', () => {
  assert.equal(resolveVersion(packument, '1.0.0'), '1.0.0');
});

test('resolveVersion: a version that was never published says so, and lists what exists', () => {
  assert.throws(() => resolveVersion(packument, '9.9.9'), (e) => {
    assert.match(e.message, /9\.9\.9/);
    assert.match(e.message, /1\.0\.0/, 'the error shows real versions to choose from');
    return true;
  });
});

test('resolveVersion: a semver range is refused with an explanation, not silently guessed', () => {
  assert.throws(() => resolveVersion(packument, '^2.0.0'), /range/i);
  assert.throws(() => resolveVersion(packument, '2.x'), /range/i);
});

test('resolveVersion: an unpublished (tombstoned) version is not installable', () => {
  const p = { name: 'd', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { version: '1.0.0' } } };
  assert.throws(() => distFor(p, '1.0.0'), /no tarball/i);
});

test('distFor: returns the tarball url and integrity the registry published', () => {
  assert.deepEqual(distFor(packument, '2.0.0'), {
    url: 'http://r/demo-2.0.0.tgz',
    integrity: 'sha512-x',
    shasum: null,
  });
});

test('verifyIntegrity: a matching sha512 subresource integrity passes', () => {
  const buf = Buffer.from('some tarball bytes');
  const integrity = 'sha512-' + createHash('sha512').update(buf).digest('base64');
  const v = verifyIntegrity(buf, { integrity, shasum: null });
  assert.equal(v.ok, true);
  assert.equal(v.algorithm, 'sha512');
});

test('verifyIntegrity: corrupted bytes fail loudly', () => {
  const integrity = 'sha512-' + createHash('sha512').update(Buffer.from('a')).digest('base64');
  const v = verifyIntegrity(Buffer.from('b'), { integrity, shasum: null });
  assert.equal(v.ok, false);
  assert.equal(v.algorithm, 'sha512');
  assert.ok(v.expected && v.actual && v.expected !== v.actual);
});

test('verifyIntegrity: falls back to the legacy sha1 shasum', () => {
  const buf = Buffer.from('older package');
  const shasum = createHash('sha1').update(buf).digest('hex');
  const v = verifyIntegrity(buf, { integrity: null, shasum });
  assert.equal(v.ok, true);
  assert.equal(v.algorithm, 'sha1');
  assert.equal(verifyIntegrity(Buffer.from('x'), { integrity: null, shasum }).ok, false);
});

test('verifyIntegrity: nothing to check against is reported, not treated as a pass', () => {
  const v = verifyIntegrity(Buffer.from('x'), { integrity: null, shasum: null });
  assert.equal(v.ok, true);
  assert.equal(v.algorithm, null);
});

test('manifestFromTarball reads the published package.json out of the bytes', { timeout: TIMEOUT }, () => {
  const { tarball } = makeTarball(fixture('good-esm'));
  const m = manifestFromTarball(tarball);
  assert.equal(m.name, 'pp-fixture-good-esm');
  assert.equal(m.version, '1.0.0');
});

// --- a fake registry, just enough of it ------------------------------------

/** Serve one fixture as if it had been published. */
async function fakeRegistry(fixtureName, { corrupt = false, omitIntegrity = false } = {}) {
  const { tarball } = makeTarball(fixture(fixtureName));
  const bytes = readFileSync(tarball);
  const manifest = manifestFromTarball(tarball);
  const served = corrupt ? Buffer.concat([bytes, Buffer.from('junk')]) : bytes;
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/-/tarball.tgz') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(served);
      return;
    }
    if (req.url === `/${encodeURIComponent(manifest.name)}` || req.url === `/${manifest.name}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: manifest.name,
          'dist-tags': { latest: manifest.version },
          versions: {
            [manifest.version]: {
              name: manifest.name,
              version: manifest.version,
              dist: {
                tarball: `${base}/-/tarball.tgz`,
                ...(omitIntegrity ? {} : { integrity }),
              },
            },
          },
        })
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    name: manifest.name,
    version: manifest.version,
    hits,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('fetchRegistryTarball downloads, verifies and names the published tarball', { timeout: TIMEOUT }, async () => {
  const reg = await fakeRegistry('good-esm');
  try {
    const got = await fetchRegistryTarball(`${reg.name}@${reg.version}`, { registryUrl: reg.url });
    assert.equal(got.name, reg.name);
    assert.equal(got.version, reg.version);
    assert.equal(got.integrity.ok, true);
    assert.equal(got.integrity.algorithm, 'sha512');
    assert.ok(got.tarball.endsWith(`${reg.name}-${reg.version}.tgz`));
    assert.equal(manifestFromTarball(got.tarball).name, reg.name);
  } finally {
    await reg.close();
  }
});

test('a bare name asks the registry for latest', { timeout: TIMEOUT }, async () => {
  const reg = await fakeRegistry('good-esm');
  try {
    const got = await fetchRegistryTarball(reg.name, { registryUrl: reg.url });
    assert.equal(got.version, reg.version);
    assert.equal(got.wanted, 'latest');
  } finally {
    await reg.close();
  }
});

test('a package the registry has never heard of fails with its name, not a stack trace', { timeout: TIMEOUT }, async () => {
  const reg = await fakeRegistry('good-esm');
  try {
    await assert.rejects(
      () => fetchRegistryTarball('pp-does-not-exist@1.0.0', { registryUrl: reg.url }),
      /pp-does-not-exist/
    );
  } finally {
    await reg.close();
  }
});

test('--registry proves a published package end to end', { timeout: TIMEOUT }, async () => {
  const reg = await fakeRegistry('good-esm');
  try {
    const r = await packproof('.', { registry: `${reg.name}@${reg.version}`, registryUrl: reg.url });
    assert.equal(r.ok, true, JSON.stringify(r.failures, null, 2));
    assert.equal(r.source, 'registry');
    assert.equal(r.packed, false, 'nothing was packed — these are the published bytes');
    assert.equal(r.name, reg.name);
    assert.equal(r.version, reg.version);
    assert.equal(r.registry.url, reg.url);
    assert.match(r.registry.tarballUrl, /tarball\.tgz$/);
    const fetched = r.checks.find((c) => c.name.startsWith('fetch '));
    assert.ok(fetched && fetched.pass, 'the fetch is itself a reported check');
    assert.match(fetched.note, /sha512/);
    // the usual probes still ran on the downloaded tarball
    assert.ok(r.checks.some((c) => c.name === 'import "pp-fixture-good-esm/util"'));
    assert.ok(r.checks.some((c) => c.name.startsWith('bin ')));
  } finally {
    await reg.close();
  }
});

test('--registry catches a real defect in a published version', { timeout: TIMEOUT }, async () => {
  const reg = await fakeRegistry('broken-devdep');
  try {
    const r = await packproof('.', { registry: reg.name, registryUrl: reg.url });
    assert.equal(r.ok, false);
    assert.deepEqual(r.failures.map((f) => f.kind), ['undeclared-dependency']);
    assert.match(r.failures[0].hint, /pp-fixture-ghost/);
  } finally {
    await reg.close();
  }
});

test('--registry works with --lazy, reading the published source', { timeout: TIMEOUT }, async () => {
  const reg = await fakeRegistry('broken-lazy-devdep');
  try {
    const r = await packproof('.', { registry: reg.name, registryUrl: reg.url, lazy: true });
    assert.equal(r.ok, false);
    assert.deepEqual(r.failures.map((f) => f.kind), ['undeclared-dependency']);
    assert.match(r.failures[0].name, /index\.js:10/);
  } finally {
    await reg.close();
  }
});

test('a tarball that does not match the published integrity is never installed', { timeout: TIMEOUT }, async () => {
  const reg = await fakeRegistry('good-esm', { corrupt: true });
  try {
    const r = await packproof('.', { registry: reg.name, registryUrl: reg.url });
    assert.equal(r.ok, false);
    assert.deepEqual(r.failures.map((f) => f.kind), ['integrity-mismatch']);
    assert.ok(!r.checks.some((c) => c.name === 'npm install <tarball>'), 'we stopped before installing');
    assert.match(r.failures[0].hint, /integrity/i);
  } finally {
    await reg.close();
  }
});

test('a registry with no integrity field still works, and says it could not verify', { timeout: TIMEOUT }, async () => {
  const reg = await fakeRegistry('good-esm', { omitIntegrity: true });
  try {
    const r = await packproof('.', { registry: reg.name, registryUrl: reg.url });
    assert.equal(r.ok, true, JSON.stringify(r.failures, null, 2));
    const fetched = r.checks.find((c) => c.name.startsWith('fetch '));
    assert.match(fetched.note, /no integrity/i);
  } finally {
    await reg.close();
  }
});

test('--registry with no spec means "this package, as published"', { timeout: TIMEOUT }, async () => {
  const reg = await fakeRegistry('good-esm');
  try {
    // registry: true is what the CLI passes for a bare --registry flag; the name
    // is read from the local package.json.
    const r = await packproof(fixture('good-esm'), { registry: true, registryUrl: reg.url });
    assert.equal(r.ok, true, JSON.stringify(r.failures, null, 2));
    assert.equal(r.name, reg.name);
    assert.equal(r.registry.spec, `${reg.name}@latest`);
  } finally {
    await reg.close();
  }
});
