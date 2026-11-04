import { extractCaller } from './mcp/server.js';
import { sessionModelId } from './agents/index.js';

// POST /pr-model — the PR footer's lookup (server/pr-footer.js). Answers
// `{ model, extensions }` for the caller's card (X-AW-Session, as /pr-attach):
// `model` is the live model off the board, else the launch model, as an exact
// id; `extensions` is the GitHub `owner/repo` of each git-installed extension
// the session used (server/extension-usage.js). Each is gated by its own
// setting: `model` is null and `extensions` empty when theirs is off, and both
// are empty for an unknown card, which the footer reads as "leave the PR
// alone". Read-only apart from `refreshUsage`, which brings the session's
// skill counts up to date before they are read.
export function createPrModelHandler({
  graph, entryFor, enabled,
  extensionsEnabled = () => false, extensionsFor = () => [], refreshUsage = async () => {},
  logError = () => {},
}) {
  return async function prModelHandler(req, res) {
    try {
      const caller = extractCaller(req);
      if (caller == null) { res.writeHead(400).end('bad request'); return; }
      let model = null;
      let extensions = [];
      const row = graph()?.sessions?.find((s) => s.sessionId === caller);
      const entry = entryFor(caller);
      if (enabled()) {
        model = sessionModelId(row?.agent ?? entry?.agent, row?.currentModel, row?.model ?? entry?.model);
      }
      if (extensionsEnabled() && (row || entry)) {
        try { await refreshUsage(caller); } catch (err) { logError('[pr-model] usage refresh', err); }
        extensions = extensionsFor(caller);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ model, extensions }));
    } catch (err) {
      logError('[pr-model]', err);
      if (!res.headersSent) res.writeHead(500).end('error');
    }
  };
}
