// What a package ships is as much a fact about the release as whether it loads.
// `npm publish` will happily put a .npmrc holding a real auth token, a .env, or
// an SSH private key inside the tarball — the file list is decided by `files`
// and .npmignore, and neither one warns you. packproof already has the exact
// list of shipped paths, so it can say so before the install even runs.
//
// The classification is the point, and precision matters more than reach: a
// credential file is a failure, editor and build cruft is a note. Nothing here
// reads file contents — only paths — so it can never be wrong about what it
// claims to have seen.

/** Turn a tarball path into its basename, lowercased for matching. */
function baseOf(path) {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

/** `.env.example` and friends are meant to ship; `.env.production` is not. */
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults?)$/i;

/**
 * Files whose only purpose is to hold a credential. Shipping one of these is
 * always a mistake, so it fails the run.
 */
const SECRETS = [
  {
    test: (base) => base === '.npmrc',
    what: 'an npm config file, which is where npm keeps registry auth tokens',
  },
  {
    test: (base) => base === '.netrc' || base === '_netrc',
    what: 'a netrc file, which holds login credentials',
  },
  {
    test: (base) => /^\.env(\..+)?$/i.test(base) && !ENV_TEMPLATE.test(base) && base !== '.env.example',
    what: 'an environment file, which is where secrets normally live',
  },
  {
    test: (base) => /^id_(rsa|dsa|ecdsa|ed25519)(_.+)?$/i.test(base),
    what: 'an SSH private key',
  },
  {
    test: (base) => /\.(pfx|p12|jks|keystore)$/i.test(base),
    what: 'a key store',
  },
  {
    test: (base, path) => /\.(pem|key)$/i.test(base) && /(priv|secret|server\.key)/i.test(path),
    what: 'a private key',
  },
  {
    test: (base, path) => /(^|\/)\.ssh\//.test(`/${path}`) || /(^|\/)\.aws\/credentials$/.test(`/${path}`),
    what: 'a credential directory',
  },
  {
    test: (base) => /^\.git-credentials$/i.test(base),
    what: 'stored git credentials',
  },
];

/**
 * Files that are merely accidental: they bloat the tarball and leak local
 * detail, but they are not a credential, so they are reported as a note rather
 * than failing somebody's release for a .DS_Store.
 */
const JUNK = [
  { test: (b) => b === '.DS_Store' || b === 'Thumbs.db' || b === 'desktop.ini', what: 'OS metadata' },
  { test: (b, p) => /(^|\/)\.git\//.test(`/${p}`), what: 'a copy of the git directory' },
  { test: (b, p) => /(^|\/)node_modules\//.test(`/${p}`), what: 'installed dependencies' },
  { test: (b, p) => /(^|\/)(coverage|\.nyc_output)\//.test(`/${p}`), what: 'coverage output' },
  { test: (b) => /^npm-debug\.log/.test(b) || /\.log$/i.test(b), what: 'a log file' },
  { test: (b) => /\.tsbuildinfo$/i.test(b), what: 'a TypeScript build cache' },
  { test: (b) => /(\.swp|\.swo|~|\.orig|\.rej|\.bak)$/i.test(b), what: 'an editor or merge leftover' },
  { test: (b, p) => /(^|\/)(\.idea|\.vscode)\//.test(`/${p}`), what: 'editor settings' },
  { test: (b) => /\.(tgz|tar\.gz)$/i.test(b), what: 'a packed tarball inside the tarball' },
  { test: (b, p) => /(^|\/)\.terraform\//.test(`/${p}`) || b === '.envrc', what: 'local tooling state' },
];

/** First matching rule, or null. */
function classify(rules, path) {
  const base = baseOf(path);
  for (const rule of rules) {
    if (rule.test(base, path)) return rule.what;
  }
  return null;
}

/**
 * Split a shipped file list into credentials and cruft.
 * Pure: takes paths, returns findings. `files` is the tarball's own path list.
 */
export function inspectShippedFiles(files = []) {
  const secrets = [];
  const junk = [];
  for (const path of files) {
    if (!path || path.endsWith('/')) continue;
    const secret = classify(SECRETS, path);
    if (secret) {
      secrets.push({ path, what: secret });
      continue; // a credential is never also merely cruft
    }
    const cruft = classify(JUNK, path);
    if (cruft) junk.push({ path, what: cruft });
  }
  return { secrets, junk };
}

/** `a, b and c`, capped so a wrecked tarball cannot print a thousand lines. */
function listOf(findings, cap = 6) {
  const shown = findings.slice(0, cap).map((f) => f.path);
  const rest = findings.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/**
 * The `shipped files` check. Always runs — it needs the file list and nothing
 * else, so it reports even when the install itself fails.
 */
export function checkShippedFiles(files = [], { strict = false } = {}) {
  const { secrets, junk } = inspectShippedFiles(files);
  const count = `${files.length} file${files.length === 1 ? '' : 's'}`;

  if (secrets.length) {
    const detail = [
      ...secrets.map((f) => `${f.path} — ${f.what}`),
      ...(junk.length ? [`also accidental: ${listOf(junk)}`] : []),
    ].join('\n');
    return {
      name: 'shipped files',
      pass: false,
      kind: 'shipped-secret',
      paths: secrets.map((f) => f.path),
      hint:
        `this tarball contains ${secrets.length === 1 ? 'a file that normally holds a credential' : 'files that normally hold credentials'}. ` +
        `Check whether ${secrets.length === 1 ? 'it is' : 'they are'} real, and keep ${secrets.length === 1 ? 'it' : 'them'} out with "files" in package.json or .npmignore. ` +
        `A published version cannot be unpublished after 72 hours, and anything already published should be treated as leaked.`,
      detail,
    };
  }

  if (junk.length) {
    const summary = `${count}; ${junk.length} look${junk.length === 1 ? 's' : ''} accidental — ${listOf(junk)}`;
    if (strict) {
      return {
        name: 'shipped files',
        pass: false,
        kind: 'shipped-cruft',
        paths: junk.map((f) => f.path),
        hint:
          `${junk.length === 1 ? 'a file' : 'files'} in this tarball ${junk.length === 1 ? 'looks' : 'look'} accidental rather than intended. ` +
          `Nothing here is a credential, so this is only a failure because you asked for --strict. ` +
          `Keep ${junk.length === 1 ? 'it' : 'them'} out with "files" in package.json or .npmignore.`,
        detail: [summary, ...junk.map((f) => `${f.path} — ${f.what}`)].join('\n'),
      };
    }
    return {
      name: 'shipped files',
      pass: true,
      paths: junk.map((f) => f.path),
      note: summary,
    };
  }

  return { name: 'shipped files', pass: true, note: `${count}, no credentials or cruft` };
}
