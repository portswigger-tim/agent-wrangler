import { log } from '../log.js';
import { realGh } from './gh-cli.js';

// What GitHub says about an extension's repositories, for the Settings →
// Extensions detail pane and the report_extension_issue tool: stars and open
// issues for the repository it was installed from, and whether the repository
// its issues go to accepts them. Read-only and unauthenticated, like the
// "+ Add extension" catalog (control/handlers/ext-browse.js), which already gets
// most of it in its search results and drops them in this cache, so a
// repository the catalog listed costs no request of its own. The one exception
// is the open-issue count, which asks a signed-in `gh` first (openIssueCount).
//
// Cached in memory per `owner/repo`, because GitHub allows an unauthenticated
// caller 60 core requests an hour and a human clicking between extensions must
// not spend them. A failure is cached too, for less time, so a rate limit is
// not hit again on every click.
//
// A LEAF: fetch, the `gh` runner and the log sink.

export const STATS_TTL_MS = 30 * 60 * 1000;
export const ERROR_TTL_MS = 5 * 60 * 1000;

const cache = new Map();
const keyOf = ({ owner, repo }) => `${owner}/${repo}`.toLowerCase();

let fetchImpl = (...args) => fetch(...args);
let now = () => Date.now();
let ghImpl = realGh;
// Tests never reach a real `gh`: unless one is given, it is signed out.
const SIGNED_OUT_GH = async () => ({ code: 4, stdout: '', stderr: 'You are not logged into any GitHub hosts.' });
export function _setStatsSeamsForTests({ fetch: f = null, clock = null, gh = null } = {}) {
  fetchImpl = f || ((...args) => fetch(...args));
  now = clock || (() => Date.now());
  ghImpl = gh || SIGNED_OUT_GH;
  cache.clear();
  counts.clear();
  loggedUnavailable.clear();
}

const api = (path) => fetchImpl(`https://api.github.com/${path}`, {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-wrangler' },
  signal: AbortSignal.timeout(15000),
});
const repoPath = ({ owner, repo }) => `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const isCount = (n) => Number.isInteger(n) && n >= 0;

// Only these fields, coerced: they come from a third-party response.
function infoOf(item) {
  const htmlUrl = String(item?.html_url || '');
  return {
    stars: Number(item?.stargazers_count) || 0,
    // GitHub's count, which includes open pull requests, so it is never shown
    // as it is: see openIssueCount.
    openIssuesAndPulls: Number(item?.open_issues_count) || 0,
    htmlUrl: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(htmlUrl) ? htmlUrl : '',
    // Absent from a response means GitHub did not say, which is not "off".
    hasIssues: item?.has_issues !== false,
    archived: item?.archived === true,
  };
}

// A repository object from any GitHub API answer (a search item or
// /repos/<owner>/<repo>) into the cache.
export function noteRepo(item) {
  const [owner, repo] = String(item?.full_name || '').split('/');
  if (!owner || !repo) return;
  cache.set(keyOf({ owner, repo }), { at: now(), info: infoOf(item) });
}

// `{ info }` or `{ status, error }` (status 0 when GitHub was not reached).
// Never throws.
async function lookup(repo) {
  const key = keyOf(repo);
  const hit = cache.get(key);
  if (hit && now() - hit.at < (hit.info ? STATS_TTL_MS : ERROR_TTL_MS)) return hit;
  let entry;
  try {
    const res = await api(repoPath(repo));
    if (res.ok) entry = { info: infoOf(await res.json()) };
    else if (res.status === 403 || res.status === 429) entry = { status: res.status, error: 'GitHub\'s rate limit was hit; try again later.' };
    else if (res.status === 404) entry = { status: 404, error: 'GitHub does not show this repository publicly.' };
    else entry = { status: res.status, error: `GitHub answered ${res.status}.` };
  } catch (err) {
    entry = { status: 0, error: String(err?.message || err) };
  }
  cache.set(key, { at: now(), ...entry });
  return entry;
}

// `{ stars, htmlUrl }`, or throws with a message for the pane.
export async function repoStats(repo) {
  const { info, error } = await lookup(repo);
  if (!info) throw new Error(error);
  return { stars: info.stars, htmlUrl: info.htmlUrl };
}

const counts = new Map();

// How many issues are open on `repo`, never counting pull requests, or null
// when that cannot be known: the pane then shows no count rather than a wrong
// one. `search` (issue-search terms, e.g. `is:issue is:open "[widgets]"
// in:title`) narrows it to one extension's issues in a repository several
// share.
//
// In order: GraphQL through a signed-in `gh`, which is exact and reaches
// private repositories; then unauthenticated, the repository's
// open_issues_count less its open pull requests, or GitHub's issue search
// (which has a tighter rate limit of its own) for `search`. Cached like the
// stats, a null for less time.
export async function openIssueCount(repo, { search = '' } = {}) {
  const key = `${keyOf(repo)} ${search}`;
  const hit = counts.get(key);
  if (hit && now() - hit.at < (hit.count === null ? ERROR_TTL_MS : STATS_TTL_MS)) return hit.count;
  const count = (await countWithGh(repo, search)) ?? (search ? await searchCount(repo, search) : await subtractedCount(repo));
  counts.set(key, { at: now(), count });
  return count;
}

const searchTerms = (repo, search) => `repo:${repo.owner}/${repo.repo} ${search}`;

async function countWithGh(repo, search) {
  const [query, vars] = search
    ? ['query($q:String!){search(query:$q,type:ISSUE){issueCount}}', ['-f', `q=${searchTerms(repo, search)}`]]
    : ['query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount}}}', ['-f', `owner=${repo.owner}`, '-f', `name=${repo.repo}`]];
  try {
    const r = await ghImpl(['api', 'graphql', '--hostname', 'github.com', '-f', `query=${query}`, ...vars]);
    if (r.code !== 0) return null;
    const data = JSON.parse(r.stdout)?.data;
    const n = search ? data?.search?.issueCount : data?.repository?.issues?.totalCount;
    return isCount(n) ? n : null;
  } catch {
    // No `gh`, or an answer that is not GraphQL's.
    return null;
  }
}

async function subtractedCount(repo) {
  const { info } = await lookup(repo);
  if (!info) return null;
  const pulls = await openPullCount(repo);
  // The two numbers are read at different times, so never below zero.
  return pulls === null ? null : Math.max(0, info.openIssuesAndPulls - pulls);
}

// One pull request per page, so the number of the `rel="last"` page in the
// Link header is the count. No Link header means it all fit on one page: 0 or 1.
async function openPullCount(repo) {
  try {
    const res = await api(`${repoPath(repo)}/pulls?state=open&per_page=1`);
    if (!res.ok) return null;
    const last = String(res.headers?.get?.('link') || '').match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
    if (last) return Number(last[1]);
    const list = await res.json();
    return Array.isArray(list) ? list.length : null;
  } catch {
    return null;
  }
}

async function searchCount(repo, search) {
  try {
    const res = await api(`search/issues?q=${encodeURIComponent(searchTerms(repo, search))}&per_page=1`);
    if (!res.ok) return null;
    const n = (await res.json())?.total_count;
    return isCount(n) ? n : null;
  } catch {
    return null;
  }
}

const loggedUnavailable = new Set();

// Whether `repo` takes new issues: `{ available: true }`, `{ available: false,
// reason }` when GitHub says it cannot (issues turned off, archived, or not
// there), or `{ available: null, reason }` when that is not known (offline,
// rate-limited) — the caller then offers the links anyway.
//
// A 404 is ambiguous without a token: a private repository looks exactly like
// a missing one. `accessible` says the human is known to reach it (it is the
// repository they installed from, which git cloned), and turns that 404 into
// "not known" rather than "not there".
export async function issuesAvailability(repo, { accessible = false } = {}) {
  const { info, status, error } = await lookup(repo);
  let out;
  if (info?.archived) out = { available: false, reason: 'The repository is archived, so it takes no new issues.' };
  else if (info && !info.hasIssues) out = { available: false, reason: 'Issues are turned off on the repository.' };
  else if (info) out = { available: true };
  else if (status === 404 && !accessible) out = { available: false, reason: 'GitHub shows no such public repository; it may not exist, or be private.' };
  else out = { available: null, reason: error };
  if (out.available === false) {
    const key = keyOf(repo);
    if (!loggedUnavailable.has(key)) {
      loggedUnavailable.add(key);
      log(`[agent-wrangler] issues unavailable on ${repo.owner}/${repo.repo}: ${out.reason}`);
    }
  }
  return out;
}
