import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A clean room: a throwaway project with nothing in it but your tarball.
 * This is the whole point — none of your devDependencies are reachable here,
 * so anything your package needs at runtime has to have shipped with it.
 */
export function createCleanRoom() {
  const dir = mkdtempSync(join(tmpdir(), 'packproof-room-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'packproof-clean-room', version: '1.0.0', private: true }, null, 2)
  );
  return {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** Install the tarball into the clean room the way a consumer would. */
export function installTarball(room, tarball, { ignoreScripts = false, timeout = 300000 } = {}) {
  const args = ['install', '--no-audit', '--no-fund', '--loglevel', 'error'];
  if (ignoreScripts) args.push('--ignore-scripts');
  args.push(tarball);
  const r = spawnSync('npm', args, { cwd: room.dir, encoding: 'utf8', timeout });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? r.error.message : null,
  };
}

/** Run a snippet of JS from inside the clean room, in its own process. */
export function runInRoom(room, code, { timeout = 60000, esm = true } = {}) {
  const file = join(room.dir, esm ? `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs` : `probe.cjs`);
  writeFileSync(file, code);
  const r = spawnSync(process.execPath, [file], { cwd: room.dir, encoding: 'utf8', timeout });
  try { rmSync(file, { force: true }); } catch {}
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

/** Execute an installed bin from the clean room's node_modules/.bin. */
export function runBin(room, binName, args = [], { timeout = 60000 } = {}) {
  const r = spawnSync(join(room.dir, 'node_modules', '.bin', binName), args, {
    cwd: room.dir,
    encoding: 'utf8',
    timeout,
    shell: false,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error ? r.error.message : null,
  };
}
