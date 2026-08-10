# packproof

**Install your npm package like a stranger would — before they do.**

[Docs & site](https://packproof-site.vercel.app) · [npm](https://www.npmjs.com/package/packproof)

```
npx packproof
```

packproof runs `npm pack`, installs the resulting tarball into an empty throwaway project
(a *clean room*), then imports every entry point, `require()`s them, and executes every
declared bin. If your package is broken for the people who install it, you find out in
about ten seconds instead of from an issue titled "doesn't work".

## Why your test suite can't catch this

Your CI runs inside your source tree. In that tree, every devDependency is installed and
hoisted, every file exists whether or not it's in `"files"`, and your bin runs as
`node ./bin/cli.js` rather than as an executable on `$PATH`. Every one of those three
differences hides a real, common, shipped-to-production bug:

| The bug | Why your tree hides it |
| --- | --- |
| a devDependency imported at runtime | it's installed locally, so the import resolves |
| a file missing from `"files"` / excluded by `.npmignore` | it's on disk, so the read succeeds |
| a bin with no `#!/usr/bin/env node` | you never exec it as a program |

`npm pack` and `npm install` report **no problem at all** for a package with all three.
They aren't lying — packing and installing genuinely succeed. Nothing has tried to *use* it.

## What it looks like

A package with a leaked devDependency and a shebang-less bin:

```console
$ npx packproof
pp-fixture-broken-everything@2.3.0 — 3 files packed
  ✓ npm install <tarball>
  ✗ import "pp-fixture-broken-everything" [undeclared-dependency]
      "kleur" is required at runtime but is only in devDependencies, where it works
      for you and for nobody else. Move it to dependencies.
      Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'kleur' imported from …
  ✗ bin "pp-fixture-everything" [bin-not-executable]
      the shell could not execute pp-fixture-everything. A missing
      "#!/usr/bin/env node" shebang is the usual cause.
      …/node_modules/.bin/pp-fixture-everything: 2: Syntax error: word unexpected

packproof: 2 problems your users would hit.
```

And when it's fine:

```console
$ npx packproof
packproof@0.1.0 — 7 files packed
  ✓ npm install <tarball>
  ✓ import "packproof"
  ✓ bin "packproof"

packproof: this package works when installed.
```

Exit code is `0` when clean, `1` when your users would hit something, `2` on a packproof
error (bad path, unparseable manifest). Drop it in CI before `npm publish`:

```yaml
- run: npx packproof
```

or in your `package.json`:

```json
{ "scripts": { "prepublishOnly": "packproof" } }
```

## Usage

```
packproof [path-or-tarball] [options]

  --json              machine-readable output
  --keep              keep the clean room and print its path
  --ignore-scripts    install with --ignore-scripts
  --skip-require      only probe ESM import, not require()
  --lazy              also scan shipped source for imports that never execute
  --bin-args <args>   args passed to each bin (default: --version)
  -h, --help          show help
  -v, --version       show packproof's version
```

Pass a directory to pack it, or an existing `.tgz` to test exactly the bytes you already
built. `--keep` leaves the clean room in place so you can go poke at it yourself.

### What gets checked

- **install** — `npm install <tarball>` into a directory containing nothing else.
- **entry points** — every specifier a consumer could reach, derived from `exports`
  (including subpaths), or from `main`/`module` when there's no export map. Probed with a
  real dynamic `import()` in a fresh process.
- **require()** — the same specifiers through `createRequire`, because CJS consumers are
  still most of the ecosystem. Skipped for `"type": "module"` packages, where failing is
  correct behaviour.
- **bins** — every entry in `bin`, actually executed from `node_modules/.bin`.
- **lazy imports** (`--lazy`) — every `.js`/`.mjs`/`.cjs` file that actually shipped is
  read back out of the clean room and scanned for bare `import`/`require` specifiers,
  resolved against your declared dependencies. This covers a gap nothing else does: **a
  devDependency required only inside a function body passes `npm pack`, passes `npm
  install`, passes publint, and passes packproof's own execution checks** — no probe ever
  runs that line, so no probe can notice. Only `--lazy` catches it.

Failures are classified, not just dumped: `undeclared-dependency`, `missing-dependency`,
`missing-file`, `bin-not-executable`, `bin-missing`, `install-failed`, `load-error`. The
classification is the useful part — "it broke" is not actionable, "your devDependency
leaked" is.

### Programmatic use

```js
import { packproof } from 'packproof';

const result = await packproof('.');
if (!result.ok) console.error(result.failures.map((f) => f.kind));
```

`result` is `{ name, version, tarball, packed, files, fileCount, checks, failures, ok, room, durationMs }`.

## packproof vs publint

Use both. They do different things, and neither one subsumes the other.

[**publint**](https://publint.dev) statically lints your published manifest: module
formats, `exports` correctness, file extensions, shebangs, deprecated fields. It is
excellent, fast, needs no install, and it will tell you about whole categories of
correctness that packproof never looks at.

**packproof** doesn't read your manifest for opinions. It installs your package and runs
it. That catches the class of bug static analysis structurally cannot see: whether the
code, at runtime, reaches for something that isn't there. A devDependency imported three
files deep behind a conditional isn't a manifest problem — it's a fact about execution.

Rough division of labour: publint answers *"is this package declared correctly?"*;
packproof answers *"does this package work once installed?"* A sensible prepublish step
runs `publint && packproof`.

## Honest limitations

- **One failure per probe.** ESM stops at the first unresolved import, so a module with
  two missing things reports one, then the other after you fix it. Separate entry points
  and bins are probed separately, so those are reported together.
- **Only reachable code is executed.** Loading a module runs its top level. A
  devDependency imported lazily inside a function that packproof never calls is never
  *run* — pass `--lazy` and it gets found by reading the shipped source instead.
- **`--lazy` is static.** It is a regex scan of the shipped text: comments and
  template-literal prose are blanked out first, but a specifier your code computes at
  runtime (`require(name)`, `import(base + mod)`) is not a literal and cannot be seen. It
  also only reads files that actually shipped in the tarball, so anything excluded from
  `files` is out of scope by construction.
- **Bins are run with `--version` by default.** If your CLI doesn't support it, a nonzero
  exit is reported as a note, not a failure; use `--bin-args` to give it something real.
- **It runs a real `npm install`.** That means the network, if you have dependencies, and
  a few seconds. It also means postinstall scripts run — pass `--ignore-scripts` if you'd
  rather they didn't.
- **No workspace/monorepo awareness yet.** Point it at one package directory at a time.

## Install

```sh
npx packproof          # no install
npm i -D packproof     # or keep it around
```

Requires Node 18+. No dependencies.

## License

MIT © flossy-studio
