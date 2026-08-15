import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectShippedFiles, checkShippedFiles } from '../src/hygiene.js';

// The contract these defend: a credential in the tarball fails the run, cruft is
// only a note, and neither verdict is ever reached by reading file *contents* —
// paths only, so the tool cannot be wrong about what it says it saw.

const paths = (findings) => findings.map((f) => f.path);

test('a shipped .npmrc is a failure, not a note', () => {
  const chk = checkShippedFiles(['package.json', 'index.js', '.npmrc']);
  assert.equal(chk.pass, false);
  assert.equal(chk.kind, 'shipped-secret');
  assert.deepEqual(chk.paths, ['.npmrc']);
  assert.match(chk.hint, /normally holds a credential/);
  assert.match(chk.detail, /^\.npmrc — an npm config file, which is where npm keeps registry auth tokens$/m);
});

test('env files are secrets but their templates are not', () => {
  const { secrets, junk } = inspectShippedFiles([
    '.env',
    '.env.production',
    '.env.local',
    '.env.example',
    '.env.sample',
    '.env.template',
    '.env.dist',
    '.env.defaults',
    'src/env.js',
  ]);
  assert.deepEqual(paths(secrets), ['.env', '.env.production', '.env.local']);
  assert.deepEqual(paths(junk), []);
});

test('private keys and key stores are secrets; public keys and certs are not', () => {
  const { secrets } = inspectShippedFiles([
    'id_rsa',
    'id_ed25519',
    'id_rsa.pub',
    'keys/client.pfx',
    'keys/store.jks',
    'test/fixtures/cert.pem',
    'test/fixtures/private.pem',
    'test/fixtures/server.key',
    'home/.ssh/config',
    '.aws/credentials',
    '.git-credentials',
  ]);
  assert.deepEqual(paths(secrets), [
    'id_rsa',
    'id_ed25519',
    'keys/client.pfx',
    'keys/store.jks',
    'test/fixtures/private.pem',
    'test/fixtures/server.key',
    'home/.ssh/config',
    '.aws/credentials',
    '.git-credentials',
  ]);
});

test('a plain .pem is left alone — test certificates legitimately ship', () => {
  const { secrets, junk } = inspectShippedFiles(['test/cert.pem', 'ca.pem']);
  assert.deepEqual(paths(secrets), []);
  assert.deepEqual(paths(junk), []);
});

test('cruft is a note on a passing check, and never a failure', () => {
  const chk = checkShippedFiles([
    'package.json',
    'index.js',
    '.DS_Store',
    'coverage/lcov.info',
    'npm-debug.log',
  ]);
  assert.equal(chk.pass, true);
  assert.equal(chk.kind, undefined);
  assert.deepEqual(chk.paths, ['.DS_Store', 'coverage/lcov.info', 'npm-debug.log']);
  assert.match(chk.note, /^5 files; 3 look accidental — /);
});

test('the cruft rules cover the things npmignore mistakes actually ship', () => {
  const { junk } = inspectShippedFiles([
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
    '.git/HEAD',
    'node_modules/lodash/index.js',
    '.nyc_output/out.json',
    'build/tsconfig.tsbuildinfo',
    'src/index.js.orig',
    'src/.index.js.swp',
    '.vscode/settings.json',
    'packproof-0.6.0.tgz',
    '.envrc',
    'src/index.js',
    'README.md',
  ]);
  assert.equal(junk.length, 12);
  assert.ok(!paths(junk).includes('src/index.js'));
  assert.ok(!paths(junk).includes('README.md'));
});

test('a credential is reported as a credential even when cruft is present too', () => {
  const chk = checkShippedFiles(['.npmrc', '.DS_Store']);
  assert.equal(chk.pass, false);
  assert.equal(chk.kind, 'shipped-secret');
  assert.match(chk.detail, /also accidental: \.DS_Store/);
});

test('a clean tarball says so, with the file count', () => {
  assert.equal(
    checkShippedFiles(['package.json', 'README.md', 'dist/index.js']).note,
    '3 files, no credentials or cruft'
  );
  assert.equal(checkShippedFiles(['package.json']).note, '1 file, no credentials or cruft');
});

test('long lists are capped so a wrecked tarball cannot flood the output', () => {
  const many = Array.from({ length: 20 }, (_, i) => `node_modules/p${i}/index.js`);
  const chk = checkShippedFiles(['package.json', ...many]);
  assert.equal(chk.pass, true);
  assert.match(chk.note, / and 14 more$/);
  assert.equal(chk.paths.length, 20);
});

test('directory entries and empty paths are ignored', () => {
  const { secrets, junk } = inspectShippedFiles(['node_modules/', '', null, undefined, '.npmrc']);
  assert.deepEqual(paths(secrets), ['.npmrc']);
  assert.deepEqual(paths(junk), []);
});

test('--strict promotes accidental files from a note to a failure', () => {
  const files = ['package.json', 'dist/index.js', '.DS_Store', 'debug.log'];
  const lenient = checkShippedFiles(files);
  assert.equal(lenient.pass, true);
  assert.equal(lenient.kind, undefined);

  const strict = checkShippedFiles(files, { strict: true });
  assert.equal(strict.pass, false);
  assert.equal(strict.kind, 'shipped-cruft');
  assert.deepEqual(strict.paths, ['.DS_Store', 'debug.log']);
  assert.match(strict.hint, /--strict/);
  // The finding itself is unchanged — only the verdict moved.
  assert.match(strict.detail, /^4 files; 2 look accidental — \.DS_Store, debug\.log$/m);
  assert.match(strict.detail, /\.DS_Store — OS metadata/);
});

test('--strict leaves the secret and clean verdicts exactly as they were', () => {
  const secret = ['package.json', '.npmrc', '.DS_Store'];
  const a = checkShippedFiles(secret);
  const b = checkShippedFiles(secret, { strict: true });
  assert.deepEqual(b, a);
  assert.equal(b.kind, 'shipped-secret');

  const clean = ['package.json', 'dist/index.js'];
  assert.deepEqual(checkShippedFiles(clean, { strict: true }), checkShippedFiles(clean));
});
