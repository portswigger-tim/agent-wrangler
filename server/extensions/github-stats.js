import { log } from '../log.js';

// What GitHub says about an extension's repositories, for the Settings →
// Extensions detail pane and the report_extension_issue tool: stars and open
// issues for the repository it was installed from, and whether the repository
// its issues go to accepts them. Read-only and unauthenticated, like the
// "+ Add extension" catalog (control/handlers/ext-browse.js), which already gets
// all of it in its search results and drops them in this cache, so a
// repository the catalog listed costs no request of its own.
//
// Cached in memory per `owner/repo`, because GitHub allows an unauthenticated
// caller 60 core requests an hour and a human clicking between extensions must
// not spend them. A failure is cached too, for less time, so a rate limit is
// not hit again on every click.
//
// A LEAF: fetch and the log sink.

export const STATS_TTL_MS = 30 * 60 * 1000;
export const ERROR_TTL_MS = 5 * 60 * 1000;

const cache = new Map();
const keyOf = ({ owner, repo }) => `${owner}/${repo}`.toLowerCase();

let fetchImpl = (...args) => fetch(...args);
let now = () => Date.now();
export function _setStatsSeamsForTests({ fetch: f = null, clock = null } = {}) {
  fetchImpl = f || ((...args) => fetch(...args));
  now = clock || (() => Date.now());
  cache.clear();
  loggedUnavailable.clear();
}

// Only these fields, coerced: they come from a third-party response.
function infoOf(item) {
  const htmlUrl = String(item?.html_url || '');
  return {
    stars: Number(item?.stargazers_count) || 0,
    // GitHub's count, which includes open pull requests.
    openIssues: Number(item?.open_issues_count) || 0,
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
    const res = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-wrangler' },
      signal: AbortSignal.timeout(15000),
    });
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

// `{ stars, openIssues, htmlUrl }`, or throws with a message for the pane.
export async function repoStats(repo) {
  const { info, error } = await lookup(repo);
  if (!info) throw new Error(error);
  return { stars: info.stars, openIssues: info.openIssues, htmlUrl: info.htmlUrl };
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
