// "Report an issue" for an extension: where an issue goes, and the pre-filled
// new-issue URL that opens it. Shared by the Settings → Extensions button and
// the report_extension_issue MCP tool (server/mcp/tools/), so the two draft the
// same issue from the same facts. Pure — no DOM, no fs — so both halves import it.
//
// Nothing here posts anything. The URL opens GitHub's new-issue form with the
// title and body filled in, and the human reviews and submits it themselves.

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

// package.json's `bugs` — a string, or `{ url, email }` — as an https:// URL,
// or '' when there is none. Like `homepage`, anything but https:// is ignored:
// a third-party href is opened in a new tab, so it gets no other scheme.
export function bugsUrlOf(bugs) {
  const raw = typeof bugs === 'string' ? bugs : (bugs && typeof bugs === 'object' && typeof bugs.url === 'string' ? bugs.url : '');
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

const newIssueUrl = ({ owner, repo }) => `https://github.com/${owner}/${repo}/issues/new`;

// A `bugs` URL on github.com that names a repository or its issues becomes that
// repository's new-issue form, keeping a query it already had on /issues/new
// (a `template` or `labels`). Any other https:// tracker is opened as it is.
function bugsTarget(bugsUrl) {
  const url = new URL(bugsUrl);
  const m = url.hostname === 'github.com' && url.pathname.match(new RegExp(`^/(${SEGMENT})/(${SEGMENT})(/issues(/new)?)?/?$`));
  if (!m) return { url: bugsUrl, prefill: false, repo: null };
  const repo = { owner: m[1], repo: m[2].replace(/\.git$/, '') };
  const query = m[4] ? url.search : '';
  return { url: `${newIssueUrl(repo)}${query}`, prefill: true, repo };
}

// Where an extension's issues go, or null when nowhere is known (the button is
// then not drawn). In order: its package.json `bugs`, Agent Wrangler's own
// repository for a core extension, then the GitHub repository it was installed
// from. `prefill` says whether the URL takes `title` and `body`.
//
// `entry` is a graph.extensions row: `{ external, origin, bugsUrl }`.
export function issueTarget(entry) {
  if (!entry) return null;
  if (entry.bugsUrl) {
    try {
      return bugsTarget(entry.bugsUrl);
    } catch {
      // Not a URL after all — fall through to what the install says.
    }
  }
  if (!entry.external) return { url: newIssueUrl(CORE_REPO), prefill: true, repo: CORE_REPO };
  const repo = githubRepoOf(entry.origin);
  return repo ? { url: newIssueUrl(repo), prefill: true, repo } : null;
}

// The repository whose stars and open issues the detail pane shows: only an
// extension installed from a GitHub URL. A core or hand-placed one has none,
// whatever its `bugs` says.
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
// hostApi, os }`, any of them possibly empty.
export function environmentLines(entry, env = {}) {
  const lines = [];
  const kind = entry.external ? (entry.origin ? 'installed from git' : 'placed by hand') : 'core';
  lines.push(`- Extension: ${code(entry.id)}${entry.version ? ` ${entry.version}` : ''} (${kind})`);
  if (entry.sha) lines.push(`- Installed commit: ${code(entry.sha)} on ${branchText(entry)}`);
  const build = env.codeVersion && env.codeVersion !== env.version ? ` (${code(env.codeVersion)})` : '';
  lines.push(`- Agent Wrangler: ${env.version || 'unknown'}${build}`);
  const range = entry.range ? `, extension declares ${code(entry.range)}` : '';
  lines.push(`- wranglerApi: ${env.hostApi || 'unknown'}${range}`);
  lines.push(`- State: ${stateText(entry)}`);
  lines.push(`- OS: ${env.os || 'unknown'}`);
  return lines;
}

const DESCRIPTION_HINT = '<!-- What went wrong, and what you expected instead. -->';
const STEPS_HINT = '<!-- 1. … -->';

export function issueBody(entry, env, { description = '', steps = '' } = {}) {
  return [
    '### What happened',
    '',
    description.trim() || DESCRIPTION_HINT,
    '',
    '### Steps to reproduce',
    '',
    steps.trim() || STEPS_HINT,
    '',
    '### Environment',
    '',
    ...environmentLines(entry, env),
    '',
    '<!-- Drafted by Agent Wrangler. Nothing has been posted: review it, remove anything you would rather not share, then submit. -->',
  ].join('\n');
}

// A core extension's issue lands among Agent Wrangler's own, so it is named.
export function issueTitle(entry, title = '') {
  const t = String(title).trim();
  if (entry.external) return clip(t, MAX_TITLE_LENGTH);
  const prefix = `[${entry.label || entry.id}] `;
  return clip(t.startsWith(prefix) ? t : `${prefix}${t}`, MAX_TITLE_LENGTH);
}

const withQuery = (url, title, body) => `${url}${url.includes('?') ? '&' : '?'}title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;

// The drafted issue: `{ url, prefill, truncated, title, body }`, or null when
// the extension has nowhere to report to. `title` and `body` are the full text,
// for a human to paste when `prefill` is false or the URL had to be shortened.
//
// Over the length limit, the description and steps are cut — never the
// environment, which is what makes a report actionable — to the longest that
// fits, found by bisection since each character can encode to up to nine.
export function extensionIssue(entry, env = {}, { title = '', description = '', steps = '' } = {}) {
  const target = issueTarget(entry);
  if (!target) return null;
  const fullTitle = issueTitle(entry, title);
  const fullBody = issueBody(entry, env, { description, steps });
  const draft = { url: target.url, prefill: target.prefill, truncated: false, title: fullTitle, body: fullBody };
  if (!target.prefill) return draft;
  const urlFor = (n) => withQuery(target.url, fullTitle, issueBody(entry, env, { description: clip(description.trim(), n), steps: clip(steps.trim(), n) }));
  const longest = Math.max(description.trim().length, steps.trim().length);
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
