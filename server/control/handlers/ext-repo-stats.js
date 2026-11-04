import { repoStats, issuesAvailability, openIssueCount } from '../../extensions/github-stats.js';
import { statsRepoOf, issueRepoOf, repoName, titleSearch } from '../../../public/extension-issue.js';

// What GitHub says about the extension the Settings → Extensions detail pane is
// showing: stars for the GitHub repository it was installed from (none for a
// core or hand-placed extension); whether its issue repository takes new
// issues, which decides whether "Report an issue" and "Request a feature" are
// drawn; and how many issues are open where its reports go. That is the whole
// repository when it is the install origin, and only the issues titled with
// this extension's id when it declares an `issuesRepo` elsewhere, which may
// collect several extensions' issues.
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
    const out = { type: 'ext-repo-stats-result', id, stats: null, issues: null, openIssues: null };
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
    // Counted only beside the stats, and not for a repository that takes no
    // issues. A null count is left out, never guessed.
    if (out.stats && out.issues && out.issues.available !== false) {
      const shared = !sameRepo(repos.issues, repos.stats);
      const count = await openIssueCount(repos.issues, shared ? { search: titleSearch(id) } : {});
      if (count !== null) out.openIssues = { count, repo: out.issues.repo, shared };
    }
    ctx.reply(out);
  },
};
