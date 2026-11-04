// Stars and open issues for an installed extension's GitHub repository, for the
// Settings → Extensions detail pane. Read-only and unauthenticated, like the
// "+ Add extension" catalog (control/handlers/ext-browse.js), which already gets
// both numbers in its search results and drops them in this cache, so a
// repository the catalog listed costs no request of its own.
//
// Cached in memory per `owner/repo`, because GitHub allows an unauthenticated
// caller 60 core requests an hour and a human clicking between extensions must
// not spend them. A failure is cached too, for less time, so a rate limit is
// not hit again on every click.
//
// A LEAF: nothing but fetch.

export const STATS_TTL_MS = 30 * 60 * 1000;
export const ERROR_TTL_MS = 5 * 60 * 1000;

const cache = new Map();
const keyOf = (owner, repo) => `${owner}/${repo}`.toLowerCase();

let fetchImpl = (...args) => fetch(...args);
let now = () => Date.now();
export function _setStatsSeamsForTests({ fetch: f = null, clock = null } = {}) {
  fetchImpl = f || ((...args) => fetch(...args));
  now = clock || (() => Date.now());
  cache.clear();
}

// Only these fields, coerced: they come from a third-party response.
function statsOf(item) {
  const htmlUrl = String(item?.html_url || '');
  return {
    stars: Number(item?.stargazers_count) || 0,
    // GitHub's count, which includes open pull requests.
    openIssues: Number(item?.open_issues_count) || 0,
    htmlUrl: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(htmlUrl) ? htmlUrl : '',
  };
}

// A repository object from any GitHub API answer (a search item or
// /repos/<owner>/<repo>) into the cache.
export function noteRepo(item) {
  const [owner, repo] = String(item?.full_name || '').split('/');
  if (!owner || !repo) return;
  cache.set(keyOf(owner, repo), { at: now(), stats: statsOf(item) });
}

// `{ stars, openIssues, htmlUrl }`, or throws with a message for the pane.
export async function repoStats({ owner, repo }) {
  const key = keyOf(owner, repo);
  const hit = cache.get(key);
  if (hit && now() - hit.at < (hit.error ? ERROR_TTL_MS : STATS_TTL_MS)) {
    if (hit.error) throw new Error(hit.error);
    return hit.stats;
  }
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-wrangler' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) throw new Error('GitHub\'s rate limit was hit; try again later.');
      throw new Error(res.status === 404 ? 'GitHub does not show this repository publicly.' : `GitHub answered ${res.status}.`);
    }
    const stats = statsOf(await res.json());
    cache.set(key, { at: now(), stats });
    return stats;
  } catch (err) {
    const error = String(err?.message || err);
    cache.set(key, { at: now(), error });
    throw new Error(error);
  }
}
