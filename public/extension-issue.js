// "Report an issue" and "Request a feature" for an extension: which GitHub
// repository the issue goes to, and the pre-filled new-issue URL that opens it.
// Shared by the Settings → Extensions links and the report_extension_issue MCP
// tool (server/mcp/tools/), so the two draft the same issue from the same facts.
// Pure — no DOM, no fs — so both halves import it.
//
// GitHub is the only issue store. Nothing here posts anything: the URL opens
// GitHub's new-issue form with the title and body filled in, and the human
// reviews and submits it themselves.

// Core extensions ship inside Agent Wrangler, so their issues are its own.
export const CORE_REPO = { owner: 'PortSwigger', repo: 'agent-wrangler' };

// GitHub answers 414 a little above 8 KB of URL; staying under 8000 leaves room
// for a browser or proxy that is stricter.
export const MAX_ISSUE_URL_LENGTH = 8000;
const MAX_TITLE_LENGTH = 200;
// A quarantine reason can quote a whole stack line; it is context, not the report.
const MAX_REASON_LENGTH = 500;
const CUT = '…';

const SEGMENT = '[\\w.-]+';

// `{ owner, repo }` for a GitHub remote, or null. The three shapes an install
// can record: https://github.com/o/r(.git), ssh://git@github.com/o/r(.git) and
// git@github.com:o/r(.git).
export function githubRepoOf(url) {
  const s = typeof url === 'string' ? url.trim() : '';
  const m = s.match(new RegExp(`^(?:https://github\\.com/|ssh://git@github\\.com/|git@github\\.com:)(${SEGMENT})/(${SEGMENT}?)(?:\\.git)?/?$`));
  return m && m[2] ? { owner: m[1], repo: m[2] } : null;
}

// GitHub's own naming rules: an owner is 1–39 letters, digits or single inner
// hyphens; a repository is 1–100 letters, digits, `.`, `_` or `-`, and not `.`
// or `..`.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

// An `issuesRepo` value — `"owner/repo"`, never a URL — as `{ owner, repo }`,
// or null when it is not one.
export function parseIssuesRepo(value) {
  if (typeof value !== 'string') return null;
  const [owner, repo, ...rest] = value.split('/');
  if (rest.length || !OWNER_RE.test(owner || '') || !REPO_RE.test(repo || '') || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

export const repoName = (repo) => (repo ? `${repo.owner}/${repo.repo}` : '');
const newIssueUrl = (repo) => `https://github.com/${repoName(repo)}/issues/new`;

// The GitHub repository an extension's issues go to, or null when there is
// none (no links are drawn, and the tool says so). In order: its own
// `issuesRepo`, which lets one maintainer collect issues for several
// extensions in one place; the GitHub repository it was installed from; and
// Agent Wrangler's own repository for a core extension.
//
// `entry` is a graph.extensions row: `{ external, origin, issuesRepo }`, where
// `issuesRepo` has already been validated server-side (index.js).
export function issueRepoOf(entry) {
  if (!entry) return null;
  const declared = parseIssuesRepo(entry.issuesRepo);
  if (declared) return declared;
  if (!entry.external) return CORE_REPO;
  return githubRepoOf(entry.origin);
}

// The repository whose stars and open issues the detail pane shows: the one
// an extension was installed from, when that is GitHub. A core or hand-placed
// extension has none, whatever its `issuesRepo` says.
export function statsRepoOf(entry) {
  return entry?.external ? githubRepoOf(entry.origin) : null;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}${CUT}` : s);
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;

function stateText(entry) {
  if (entry.quarantine) return `quarantined: ${clip(String(entry.quarantine), MAX_REASON_LENGTH)}`;
  return entry.enabled ? 'enabled' : 'disabled';
}

function branchText(entry) {
  const ea = entry.earlyAdopter;
  if (ea?.branch && ea.enabled) return `${code(ea.branch)} (early adopter)`;
  return 'default branch';
}

// The facts block. `env` is the wrangler's side: `{ version, codeVersion,
// hostApi, os }`, any of them possibly empty. A feature request gets the
// `short` block — which extension and which wrangler — since the commit, state
// and OS are there to reproduce a bug.
export function environmentLines(entry, env = {}, { short = false } = {}) {
  const lines = [];
  const kind = entry.external ? (entry.origin ? 'installed from git' : 'placed by hand') : 'core';
  lines.push(`- Extension: ${code(entry.id)}${entry.version ? ` ${entry.version}` : ''} (${kind})`);
  // A shared issues repository collects reports for several extensions, so
  // say which repository this one came from.
  const origin = githubRepoOf(entry.origin);
  if (origin || entry.origin) lines.push(`- Repository: ${origin ? repoName(origin) : code(entry.origin)}`);
  if (entry.sha && !short) lines.push(`- Installed commit: ${code(entry.sha)} on ${branchText(entry)}`);
  const build = env.codeVersion && env.codeVersion !== env.version ? ` (${code(env.codeVersion)})` : '';
  lines.push(`- Agent Wrangler: ${env.version || 'unknown'}${build}`);
  if (short) return lines;
  const range = entry.range ? `, extension declares ${code(entry.range)}` : '';
  lines.push(`- wranglerApi: ${env.hostApi || 'unknown'}${range}`);
  lines.push(`- State: ${stateText(entry)}`);
  lines.push(`- OS: ${env.os || 'unknown'}`);
  return lines;
}

// GitHub issue-search terms for one extension's open issues in a repository
// it shares with others, found by the `[<id>]` prefix issueTitle gives every
// draft. Search drops the brackets, so this matches the id as a title word.
export const titleSearch = (id) => `is:issue is:open "[${id}]" in:title`;

// A bug report or a feature request. Each kind is its body's sections, in
// order — `[heading, field, hint]`, where a section with no hint is optional
// and left out when its field is empty — and the label GitHub applies when the
// reporter is allowed to label (and ignores otherwise).
export const ISSUE_KINDS = {
  bug: {
    label: 'bug',
    sections: [
      ['What happened', 'description', '<!-- What went wrong, and what you expected instead. -->'],
      ['Steps to reproduce', 'steps', '<!-- 1. … -->'],
    ],
  },
  feature: {
    label: 'enhancement',
    sections: [
      ['What I\'d like', 'description', '<!-- The change you would like, as you would use it. -->'],
      ['Why / what I was doing', 'why', '<!-- What you were trying to do when you wanted it. -->'],
      ['How it might look', 'how', null],
    ],
  },
};

const kindOf = (kind) => (Object.hasOwn(ISSUE_KINDS, kind) ? kind : 'bug');
const FIELDS = ['description', 'steps', 'why', 'how'];

// `text` is `{ kind, description, steps, why, how }`; only the kind's own
// fields are used.
export function issueBody(entry, env, text = {}) {
  const kind = kindOf(text.kind);
  const out = [];
  for (const [heading, field, hint] of ISSUE_KINDS[kind].sections) {
    const value = String(text[field] || '').trim();
    if (!value && !hint) continue;
    out.push(`### ${heading}`, '', value || hint, '');
  }
  return [
    ...out,
    '### Environment',
    '',
    ...environmentLines(entry, env, { short: kind === 'feature' }),
    '',
    '<!-- Drafted by Agent Wrangler. Nothing has been posted: review it, remove anything you would rather not share, then submit. -->',
  ].join('\n');
}

// One repository can collect issues for several extensions (and Agent
// Wrangler's own holds every core one), so the title names the extension.
export function issueTitle(entry, title = '') {
  const t = String(title).trim();
  const prefix = `[${entry.id}] `;
  return clip(t.startsWith(prefix) ? t : `${prefix}${t}`, MAX_TITLE_LENGTH);
}

// GitHub ignores `labels` for a reporter who may not label the repository.
const withQuery = (url, title, body, label) => `${url}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=${encodeURIComponent(label)}`;

// The drafted issue: `{ repo, url, truncated, kind, title, body }`, or null
// when the extension has no issue repository. `repo` is `"owner/repo"`;
// `title` and `body` are the full text, for a human to paste when the URL had
// to be shortened. `kind` is 'bug' (the default) or 'feature'.
//
// Over the length limit, the free-text fields are cut — never the environment,
// which is what makes a report actionable — to the longest that fits, found by
// bisection since each character can encode to up to nine.
export function extensionIssue(entry, env = {}, { kind: askedKind = 'bug', title = '', ...fields } = {}) {
  const repo = issueRepoOf(entry);
  if (!repo) return null;
  const url = newIssueUrl(repo);
  const kind = kindOf(askedKind);
  const text = Object.fromEntries(FIELDS.map((f) => [f, String(fields[f] || '').trim()]));
  const fullTitle = issueTitle(entry, title);
  const fullBody = issueBody(entry, env, { kind, ...text });
  const draft = { repo: repoName(repo), truncated: false, kind, title: fullTitle, body: fullBody };
  const cut = (n) => Object.fromEntries(FIELDS.map((f) => [f, clip(text[f], n)]));
  const urlFor = (n) => withQuery(url, fullTitle, issueBody(entry, env, { kind, ...cut(n) }), ISSUE_KINDS[kind].label);
  const longest = Math.max(...FIELDS.map((f) => text[f].length));
  if (urlFor(longest).length <= MAX_ISSUE_URL_LENGTH) return { ...draft, url: urlFor(longest) };
  let lo = 0;
  let hi = longest;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (urlFor(mid).length <= MAX_ISSUE_URL_LENGTH) lo = mid;
    else hi = mid - 1;
  }
  return { ...draft, url: urlFor(lo), truncated: true };
}
