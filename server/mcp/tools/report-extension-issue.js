import { z } from 'zod';
import { extensionsForGraph } from '../../extensions/index.js';
import { HOST_API_VERSION } from '../../host-api/version.js';
import { VERSION, platformText } from '../../version.js';
import { issuesAvailability } from '../../extensions/github-stats.js';
import { extensionIssue, issueRepoOf, statsRepoOf } from '../../../public/extension-issue.js';

const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
const result = (structuredContent) => ({ content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent });

// Drafts a bug report or feature request about an extension, for the human to
// review and submit. The URL is built by public/extension-issue.js, the same
// code as the Settings → Extensions links, from the same facts. Nothing is
// posted: this returns a link, and only reads GitHub to check the repository
// takes issues.
//
// No issue repository, or one GitHub says takes no issues, is an ANSWER
// (`available: false` with a reason), not an error: the agent tells the human
// and moves on.
export const reportExtensionIssueTool = {
  name: 'report_extension_issue',
  description:
    'Draft a bug report or feature request about an Agent Wrangler extension, for the human to review and submit. '
    + 'Returns a pre-filled GitHub new-issue URL on the extension\'s issue repository (its declared `issuesRepo`, '
    + 'the GitHub repository it was installed from, or Agent Wrangler\'s own for a core extension), titled '
    + '`[<extension id>] …`. The body adds the extension id, version, origin repository, installed commit and branch, '
    + 'Agent Wrangler version, host API, enabled or quarantine state, and OS (a feature request gets just the '
    + 'extension, repository and Agent Wrangler versions). It posts nothing: give the URL to the human to open. '
    + 'Draft a feature request only after the human said yes to one. Never file the issue yourself with '
    + '`gh issue create` or the API. `available: false` means there is nowhere to file it, with the reason to '
    + 'pass on. When `truncated` is true, also give the human the returned `title` and `body` to paste. Read the '
    + 'report-extension-issue skill first.',
  inputSchema: {
    kind: z.enum(['bug', 'feature']).optional().describe('"bug" (default) for something broken, "feature" for a change the human asked for.'),
    extensionId: z.string().min(1).describe('The extension id, as Settings → Extensions or the extension\'s own tools name it.'),
    title: z.string().min(1).max(200).describe('A short summary of the problem or the wish. The `[<extension id>]` prefix is added for you.'),
    description: z.string().min(1).describe('Bug: what happened and what you expected instead, with any error text. Feature: what the human would like. No secrets, tokens or private paths.'),
    steps: z.string().optional().describe('Bug only: numbered steps that reproduce it, if known.'),
    why: z.string().optional().describe('Feature only: why they want it, or what they were doing when they did.'),
    how: z.string().optional().describe('Feature only: how it might look or work, if they said.'),
  },
  async handler({ deps }, args = {}) {
    const entries = extensionsForGraph(deps.ext?.list || []);
    const entry = entries.find((e) => e.id === args.extensionId);
    if (!entry) {
      return errorResult(`Unknown extension "${args.extensionId}". Installed extensions: ${entries.map((e) => e.id).join(', ') || '(none)'}.`);
    }
    const repo = issueRepoOf(entry);
    if (!repo) {
      return result({ available: false, reason: `Extension "${entry.id}" has no issue repo: it declares no issuesRepo and was not installed from GitHub. Tell the human what went wrong instead.`, posted: false });
    }
    const origin = statsRepoOf(entry);
    const accessible = Boolean(origin) && `${origin.owner}/${origin.repo}`.toLowerCase() === `${repo.owner}/${repo.repo}`.toLowerCase();
    const availability = await issuesAvailability(repo, { accessible });
    if (availability.available === false) {
      return result({ available: false, repo: `${repo.owner}/${repo.repo}`, reason: availability.reason, posted: false });
    }
    const env = { version: VERSION, codeVersion: deps.graph?.()?.codeVersion || '', hostApi: HOST_API_VERSION, os: platformText() };
    const draft = extensionIssue(entry, env, {
      kind: args.kind || 'bug', title: args.title, description: args.description, steps: args.steps, why: args.why, how: args.how,
    });
    return result({
      available: true,
      // Not confirmed when GitHub could not be asked; the link is still offered.
      ...(availability.available === null ? { unconfirmed: availability.reason } : {}),
      kind: draft.kind,
      repo: draft.repo,
      url: draft.url,
      truncated: draft.truncated,
      title: draft.title,
      body: draft.body,
      posted: false,
    });
  },
};
