import { extractCaller } from './mcp/server.js';
import { sessionModelId } from './agents/index.js';

// POST /pr-model — the PR footer's lookup (server/pr-footer.js). Answers
// `{ model, extensions }` for the caller's card (X-AW-Session, as /pr-attach):
// `model` is the live model off the board, else the launch model, as an exact
// id; `extensions` is the GitHub `owner/repo` of each git-installed extension
// the session used (server/extension-usage.js); `usage` is the per-extension
// table for the PR named by X-AW-PR (pr-footer.js usageBlock). Each is gated by
// its own setting: `model` is null, `extensions` empty and `usage` null when
// theirs is off, and all are empty for an unknown card, which the footer reads
// as "leave the PR alone". Writes nothing but the ledger: `refreshUsage`
// brings the session's skill counts up to date before they are read, and
// `usageFor` starts the session's next usage window at this PR.
export function createPrModelHandler({
  graph, entryFor, enabled,
  extensionsEnabled = () => false, extensionsFor = () => [], refreshUsage = async () => {},
  usageEnabled = () => false, usageFor = () => null,
  logError = () => {},
}) {
  return async function prModelHandler(req, res) {
    try {
      const caller = extractCaller(req);
      if (caller == null) { res.writeHead(400).end('bad request'); return; }
      let model = null;
      let extensions = [];
      let usage = null;
      const row = graph()?.sessions?.find((s) => s.sessionId === caller);
      const entry = entryFor(caller);
      if (enabled()) {
        model = sessionModelId(row?.agent ?? entry?.agent, row?.currentModel, row?.model ?? entry?.model);
      }
      if (extensionsEnabled() && (row || entry)) {
        try { await refreshUsage(caller); } catch (err) { logError('[pr-model] usage refresh', err); }
        extensions = extensionsFor(caller);
        if (extensions.length && usageEnabled()) {
          const pr = typeof req.headers['x-aw-pr'] === 'string' ? req.headers['x-aw-pr'] : null;
          usage = usageFor(caller, pr);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ model, extensions, usage }));
    } catch (err) {
      logError('[pr-model]', err);
      if (!res.headersSent) res.writeHead(500).end('error');
    }
  };
}
