import { repoStats, issuesAvailability } from '../../extensions/github-stats.js';
import { statsRepoOf, issueRepoOf, repoName } from '../../../public/extension-issue.js';

// What GitHub says about the extension the Settings → Extensions detail pane is
// showing: stars and open issues for the GitHub repository it was installed
// from (none for a core or hand-placed extension), and whether its issue
// repository takes new issues, which decides whether "Report an issue" and
// "Request a feature" are drawn.
//
// The frame names an extension id, never a repository: both repositories are
// resolved here from what the install recorded and the manifest declared, so
// a browser cannot point this at any GitHub URL it likes.
//
// Every outcome is replied as ext-repo-stats-result, never thrown, so the pane
// can stop waiting.
export function extensionRepos(entry) {
  const facts = { external: entry.external, origin: entry.provenance?.originUrl || '', issuesRepo: entry.issuesRepo || '' };
  return { stats: statsRepoOf(facts), issues: issueRepoOf(facts) };
}

const sameRepo = (a, b) => Boolean(a && b) && repoName(a).toLowerCase() === repoName(b).toLowerCase();

export const extRepoStatsHandler = {
  type: 'ext-repo-stats',
  async handler(msg, ctx) {
    const id = typeof msg.id === 'string' ? msg.id : '';
    const entry = ctx.ext.list.find((e) => e.id === id);
    const repos = entry ? extensionRepos(entry) : { stats: null, issues: null };
    const out = { type: 'ext-repo-stats-result', id, stats: null, issues: null };
    if (repos.stats) {
      try {
        out.stats = await repoStats(repos.stats);
      } catch (err) {
        out.statsError = String(err?.message || err);
      }
    }
    if (repos.issues) {
      // The install origin was cloned, so the human can reach it even when
      // GitHub hides it from an unauthenticated look.
      const availability = await issuesAvailability(repos.issues, { accessible: sameRepo(repos.issues, repos.stats) });
      out.issues = { repo: repoName(repos.issues), ...availability };
    }
    ctx.reply(out);
  },
};
