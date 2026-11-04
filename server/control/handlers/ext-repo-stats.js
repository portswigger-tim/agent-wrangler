import { repoStats } from '../../extensions/github-stats.js';
import { statsRepoOf } from '../../../public/extension-issue.js';

// Stars and open issues for the extension the Settings → Extensions detail pane
// is showing. The frame names an extension id, never a repository: the
// repository is the one its install recorded, so a browser cannot point this at
// any GitHub URL it likes. Only an extension installed from a GitHub URL has
// one (statsRepoOf); a core or hand-placed extension gets no stats.
//
// Every outcome is replied as ext-repo-stats-result, never thrown, so the pane
// can stop waiting.
export const extRepoStatsHandler = {
  type: 'ext-repo-stats',
  async handler(msg, ctx) {
    const id = typeof msg.id === 'string' ? msg.id : '';
    const entry = ctx.ext.list.find((e) => e.id === id);
    const repo = entry && statsRepoOf({ external: entry.external, origin: entry.provenance?.originUrl || '' });
    if (!repo) {
      ctx.reply({ type: 'ext-repo-stats-result', id, error: 'Not installed from a GitHub repository.' });
      return;
    }
    try {
      ctx.reply({ type: 'ext-repo-stats-result', id, ...(await repoStats(repo)) });
    } catch (err) {
      ctx.reply({ type: 'ext-repo-stats-result', id, error: String(err?.message || err) });
    }
  },
};
