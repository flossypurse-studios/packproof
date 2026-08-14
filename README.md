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

It also works on packages that are already published — yours or anyone else's:

```
npx packproof --registry left-pad@1.3.0
```

That downloads the exact tarball the registry serves, checks it against the integrity hash
the registry published for it, and clean-rooms *those bytes*. No local checkout involved.

In a monorepo it does every package the workspace declares, each in its own clean room:

```
npx packproof --workspaces
```

In CI it speaks your CI's language, so a failure lands on the offending line instead of in
scrollback:

```
npx packproof --lazy --format=github     # GitHub Actions annotations
npx packproof --format=junit --out packproof.xml
```

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

  --workspaces        prove every package in the workspace, one clean room each
  --workspace <name>  only this workspace package (repeatable; implies --workspaces)
  --include-private   do not skip private workspace packages
  --registry [spec]   prove a published package instead of the local tree
  --registry-url <u>  registry to ask (default https://registry.npmjs.org)
  --json              machine-readable output (same as --format=json)
  --format <fmt>      human (default), json, github or junit
  --out <file>        write the formatted report to a file instead of stdout
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

### Proving a published version (`--registry`)

```sh
packproof --registry                  # this package, at its latest published tag
packproof --registry chalk@4.1.2      # someone else's release, exact version
packproof --registry mypkg@next       # any dist-tag
```

Nothing is packed: packproof resolves the spec against the registry, downloads
`dist.tarball`, verifies it against the published `dist.integrity` (or the legacy
`shasum`), and only then installs it. A hash mismatch is reported as
`integrity-mismatch` and **nothing is installed**.

Why you'd want it:

- **Audit a release after the fact.** `prepublishOnly` proves the tree you had; this
  proves the artifact users actually download. Registry state can differ from your working
  copy — a stale `files` list, a two-factor republish, a CI that packed from a different
  commit.
- **Vet a dependency before you adopt it.** Does that package you're about to add even
  import cleanly with nothing else installed?
- **Reproduce a bug report against the version the reporter has**, not against `main`.

An exact version or a dist-tag is required. Ranges (`^1.2.0`) are refused rather than
resolved, because packproof's answer is about one specific set of bytes and should not
change under you. `--registry-url` points at a private or mirrored registry (the
`PACKPROOF_REGISTRY`-style env var is deliberately absent: the registry you proved
against is printed in the output and recorded in `--json`).

### Monorepos (`--workspaces`)

```sh
packproof --workspaces                      # every package the workspace declares
packproof --workspace @acme/core            # just one of them (by name or by directory)
packproof --workspaces --format=junit --out packproof.xml
```

A monorepo publishes several packages, and each one is a separate promise to a stranger.
`--workspaces` reads the `workspaces` globs from your root `package.json` (a
`pnpm-workspace.yaml` works too) and packs and clean-rooms **each package
independently** — a separate empty project per package, never a shared one, because a
shared clean room would hide exactly the bug packproof exists to find.

```
acme — 3 packages from package.json, one clean room each

@acme/core@2.1.0 packages/core — 14 files packed
  ✓ npm install <tarball>
  ✓ import "@acme/core"

@acme/cli@2.1.0 packages/cli — 9 files packed
  ✗ npm install <tarball> [workspace-sibling-dependency]
      depends on @acme/core@workspace:*, another package in this workspace. A stranger
      installs from the registry, not from your checkout...

- @acme/docs apps/docs — skipped, private

packproof: 1 problem your users would hit, in 1 of 2 packages (@acme/cli).
```

Private packages are skipped — nobody installs them — unless you pass
`--include-private`. Each package keeps its own path prefix, so `--format=github`
annotates `packages/core/src/a.js` and not `src/a.js`, and `--format=junit` emits one
`<testsuite>` per package inside a single `<testsuites>`. Exit codes are unchanged:
**1** if *any* package has a problem your users would hit.

**A dependency on a sibling package is its own kind of finding.** A clean room installs
from the registry, so a tarball that depends on another package in your workspace can
only be proved once that sibling is published at a version the range resolves to. When
the install fails for that reason, packproof reports
`workspace-sibling-dependency` — not `undeclared-dependency`, because the dependency
is declared; it just isn't reachable from outside your checkout. A `workspace:` range
is the sharp case: `npm pack` leaves it in the tarball verbatim, so publishing it ships
a version nobody can install. If the sibling *is* published and resolves, the install
passes and packproof notes where it came from.

**Once packproof knows about sibling dependencies, it knows enough to say what order to
publish them in.** With more than one package in the workspace, `--workspaces` prints a
release order for free — a topological sort over the packages' own dependencies on each
other, leaves first:

```
release order — 3 steps, leaves first: publish each step before the next
  1. @acme/core
  2. @acme/utils   — needs @acme/core
  3. @acme/cli     — needs @acme/core, @acme/utils
```

If nothing in the workspace depends on anything else in it, packproof says so instead of
printing a trivial order (`any order works`). If two packages depend on each other —
directly or through a longer chain — there is no order that works, and packproof says
that instead of guessing:

```
release order — none exists [workspace-dependency-cycle]
  @acme/a → @acme/b → @acme/a
  these packages depend on each other, so none of them can be published first at a version
  the others' ranges resolve to. Break the cycle — or publish them together, by hand, once.
```

The order only covers packages a stranger could install — private packages are left out
unless `--include-private` is given — and it rides along in `--json` as `releaseOrder`
(`waves`, `steps`, `cycles`) for scripting a real publish loop.

### In CI (`--format=github`, `--format=junit`)

```sh
packproof --lazy --format=github                 # GitHub Actions annotations
packproof --format=junit --out packproof.xml     # JUnit XML for everything else
```

A failure that scrolls past in a log costs the same as no failure at all. With
`--format=github`, packproof emits workflow commands instead of prose:

```
::error file=src/render.js,line=42,title=undeclared-dependency::require("kleur") in src/render.js:42%0A"kleur" is loaded at runtime from src/render.js:42 but is only in devDependencies...
```

Actions turns that into a red annotation **on line 42 of `src/render.js`** in the diff.
The file and line come from `--lazy`, which is the only check that knows a location, so
`--lazy --format=github` is the combination worth wiring up. A failure with no file —
the install itself, a broken bin — degrades to a bare `::error title=<kind>::`, which
still shows up in the log and in the job summary. A clean run emits one `::notice` so
the step is never silently empty. Message values are escaped exactly as Actions requires
(`%` → `%25`, newlines → `%0A`), and property values additionally escape `:` and `,`;
get that wrong and Actions truncates the line without telling you.

`--format=junit` writes a JUnit XML report — one `<testcase>` per check, a
`<failure type="<kind>">` per problem, `file`/`line` attributes where known — which
GitLab, Jenkins, CircleCI, Buildkite and the `dorny/test-reporter` action all ingest.
A packproof error (exit 2) is written as an `<error>` testcase, so a crash can never be
read as green.

Exit codes are unchanged by any format: **0** clean, **1** a problem your users would
hit, **2** packproof itself failed. In `--registry` mode no `file=` is emitted at all:
those bytes came from the registry and need not match anything in your checkout.

A minimal workflow step:

```yaml
- run: npx packproof --lazy --format=github
```

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
`missing-file`, `bin-not-executable`, `bin-missing`, `install-failed`, `load-error`,
`workspace-sibling-dependency`, `integrity-mismatch`. The
classification is the useful part — "it broke" is not actionable, "your devDependency
leaked" is.

### Programmatic use

```js
import { packproof } from 'packproof';

const result = await packproof('.');
if (!result.ok) console.error(result.failures.map((f) => f.kind));
```

`result` is `{ name, version, source, registry, tarball, packed, files, fileCount, checks, failures, ok, room, durationMs }`.

`source` is `'local'` or `'registry'`; `registry` is `null` unless you passed the option, in
which case it records `{ spec, url, tarballUrl, bytes, integrity }`. To prove a published
version programmatically: `await packproof('.', { registry: 'chalk@4.1.2' })`.

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
- **Annotation paths are relative to the working directory.** `--format=github` prefixes
  the shipped file's path with the target directory you passed, so run packproof from the
  repository root (`packproof packages/foo`) and Actions will find the file. Paths outside
  the checkout are not guessed at, and `--registry` mode emits no `file=` at all.
- **A workspace package that depends on an unpublished sibling cannot be fully proved.**
  packproof says so (`workspace-sibling-dependency`) rather than pretending: releasing a
  monorepo means publishing the leaves first, then proving the packages above them with
  `--registry`. Nothing installs a sibling out of your checkout, and packproof will not
  fake it by linking one in.
- **Workspace discovery is glob matching, not a package manager.** `*`, `**`, `?` and
  `!` negations in `workspaces` (or `pnpm-workspace.yaml`) are honoured; anything more
  exotic than that, and packproof will miss a package rather than guess.
- **`--registry` trusts the registry's own hash, not a signature.** It proves the bytes
  you downloaded are the bytes the registry has on record for that version; it is not
  provenance or a signature check.

## Install

```sh
npx packproof          # no install
npm i -D packproof     # or keep it around
```

Requires Node 18+. No dependencies.

## License

MIT © flossy-studio
