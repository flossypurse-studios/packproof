# Changelog

Every release of packproof, newest first. Dates are the day the version went to npm.
packproof is pre-1.0: the CLI's output is meant to be read by people and by CI, and while
no release so far has removed a flag, new checks do add lines to a report.

## 0.11.0 — 2026-08-15

**`--only` and `--skip`.** A run was all-or-nothing, and the all included a real `npm
install` into a clean room — the slow part, and exactly what a fast lane wants to drop. The
eight check groups now have names you can select: `shipped-files`, `diff`, `install`,
`entries`, `require`, `bins`, `engines`, `lazy`. Both flags are repeatable and
comma-separated. `packproof --skip install` is a credential-and-file-list check that needs
no install at all; `--only entries` implies the install, because that is a prerequisite.

**A run that skipped checks says so, everywhere.** The human report lists each check that
did not run and why, `--json` gains `skippedChecks` (plus `fullRun` and `installed`),
JUnit emits real `<skipped>` testcases and a `skipped="n"` count, and `--format=github`
adds a notice. The verdict line is the part that matters: a run that never installed the
package no longer prints "this package works when installed" — it says plainly that it never
installed it and therefore proves nothing about installing it. A green packproof that quietly
checked three of eight things is the lie this tool exists to prevent.

Contradictions are refused with exit 2 rather than resolved by guessing: `--only entries
--skip install`, `--only x --skip x`, `--only diff` with no `--diff`, skipping everything,
and an unknown id (which prints the real ids, never a guess at your typo). `--skip-require`
still works and is now the older spelling of `--skip require`; it is reported as a skip like
any other. A run with neither flag is byte-identical to 0.10.0.

## 0.10.0 — 2026-08-15

**The Node version you promised.** `engines.node` is a claim nothing in the npm toolchain
verifies. If the manifest declares one, packproof now finds every Node installed on the
machine — the one it is running as, plus nvm, fnm, n, volta and asdf version directories —
picks the **oldest** one the range accepts, and imports every entry point again under it.
A package that does not load on a Node it says it supports fails as `engines-unsatisfied`,
with the reason named (a builtin that does not exist there, syntax that will not parse, an
API that is missing).

The other half of the feature is what happens when it cannot check. packproof does not
download a Node and will not pretend: a claim it could not verify passes with a note that
says which Node it actually used and that the floor is unverified
(`engines-partly-verified`, `engines-unverified`), and `--strict` deliberately does *not*
promote those — not having Node 18 on your laptop is a fact about your laptop, not a bug in
the package.

No new flag; the check appears whenever `engines.node` is set, and no check line at all
when nothing was promised.

## 0.9.0 — 2026-08-15

`--strict`: the three findings packproof deliberately reports as notes become failures when
you ask for them — accidental files in the tarball (`shipped-cruft`), a file that stopped
shipping without being a declared entry point (`dropped-file`), and a bin that runs but
exits nonzero (`bin-nonzero-exit`). Same findings, stricter verdict; non-strict output is
unchanged byte for byte.

## 0.8.0 — 2026-08-14

`--diff [version]`: compare the shipped file list against an already-published version.
Catches what execution cannot — a template, a `.wasm`, a locale JSON, a whole `dist/`
dropping out when `files` or `.npmignore` changes while every probe still passes. A path
the published `package.json` resolved imports to that is gone fails
(`dropped-entry-point`), type declarations vanishing entirely fails (`dropped-types`),
anything else gone is named on a passing check. A first release says it has no baseline;
an unreachable registry is a `diff-unavailable` failure, never a quiet pass.

## 0.7.0 — 2026-08-14

The **shipped files** check: the tarball's own path list, read before the install runs, for
files that should never have been in it. A `.npmrc`, a `.env`, an SSH private key, a key
store, `.aws/credentials` fail the run (`shipped-secret`); cruft like `.DS_Store`, a
shipped `node_modules` or a `.tgz` inside the `.tgz` is a note. Path matching only —
packproof never reads a file's contents to decide it is a secret.

## 0.6.0 — 2026-08-14

**Release order** for workspaces: with more than one package, packproof prints the order to
publish in, leaves first, computed from the dependency edges between the packages
themselves. A dependency cycle prints the loop instead of an order, because no order works.

## 0.5.0 — 2026-08-12

`--workspaces`, `--workspace <name>`, `--include-private`: prove every package a monorepo
declares (npm/yarn `workspaces` or `pnpm-workspace.yaml`), each in its own independent
clean room. Private packages are skipped — nobody installs them. A package that depends on
an unpublished sibling is reported as `workspace-sibling-dependency` rather than faked with
a link.

## 0.4.0 — 2026-08-12

CI-shaped output: `--format=github` emits GitHub Actions annotations, so a `--lazy` finding
lands on the offending line of the diff instead of in scrollback; `--format=junit` writes a
JUnit XML report that GitLab, Jenkins, CircleCI, Buildkite and `dorny/test-reporter`
ingest. `--out <file>` writes the report to a file. A packproof error is written as an
`<error>` testcase, so a crash can never read as green.

## 0.3.0 — 2026-08-12

`--registry [spec]`: skip packing and prove a version that is already published — yours or
anyone else's. The tarball is downloaded from the registry and checked against the
integrity hash the registry published for it (`integrity-mismatch` if it does not match,
and nothing is installed). `--registry-url` points at a different registry.

## 0.2.0 — 2026-08-10

`--lazy`: read the shipped source for `import`/`require` specifiers hidden inside functions
and branches that merely loading the package never reaches, and check those are declared
too. This is the one gap nothing else covers — a devDependency required only inside a
function body passes `npm pack`, `npm install`, publint and packproof's own execution
checks, because no probe ever runs that line.

## 0.1.1 — 2026-08-10

Docs: link the site, point `homepage` at the live URL.

## 0.1.0 — 2026-08-10

First release. `npm pack`, install the tarball into an empty throwaway project where none
of your devDependencies exist, then import every entry point, `require()` them, and execute
every declared bin. Failures are classified — `undeclared-dependency`,
`missing-dependency`, `missing-file`, `bin-not-executable`, `bin-missing`,
`install-failed`, `load-error` — because "it broke" is not actionable and "your
devDependency leaked" is.
