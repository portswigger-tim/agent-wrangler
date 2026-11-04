import { z } from 'zod';
import { extensionsForGraph } from '../../extensions/index.js';
import { HOST_API_VERSION } from '../../host-api/version.js';
import { VERSION, platformText } from '../../version.js';
import { extensionIssue } from '../../../public/extension-issue.js';

const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

// Drafts a bug report or feature request about an extension, for the human to review and submit. The
// URL is built by public/extension-issue.js, the same code as the Settings →
// Extensions "Report an issue" button, from the same facts. Nothing is posted:
// this returns a link and never calls GitHub.
export const reportExtensionIssueTool = {
  name: 'report_extension_issue',
  description:
    'Draft a bug report or feature request about an Agent Wrangler extension, for the human to review and submit. '
    + 'Returns a pre-filled new-issue URL on the extension\'s tracker (its package.json `bugs`, Agent Wrangler\'s '
    + 'own repository for a core extension, or the GitHub repository it was installed from). The body adds the '
    + 'extension version, installed commit and branch, Agent Wrangler version, host API, enabled or quarantine '
    + 'state, and OS (a feature request gets just the extension and Agent Wrangler versions). It posts nothing: '
    + 'give the URL to the human to open. Draft a feature request only after the human said yes to one. Never file the issue yourself with '
    + '`gh issue create` or the API. When `prefilled` is false, or `truncated` is true, also give the human the '
    + 'returned `title` and `body` to paste. Read the report-extension-issue skill first.',
  inputSchema: {
    kind: z.enum(['bug', 'feature']).optional().describe('"bug" (default) for something broken, "feature" for a change the human asked for.'),
    extensionId: z.string().min(1).describe('The extension id, as Settings → Extensions or the extension\'s own tools name it.'),
    title: z.string().min(1).max(200).describe('A short summary of the problem or the wish.'),
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
    const env = { version: VERSION, codeVersion: deps.graph?.()?.codeVersion || '', hostApi: HOST_API_VERSION, os: platformText() };
    const draft = extensionIssue(entry, env, {
      kind: args.kind || 'bug', title: args.title, description: args.description, steps: args.steps, why: args.why, how: args.how,
    });
    if (!draft) {
      return errorResult(`Extension "${entry.id}" names no issue tracker: its package.json has no https:// \`bugs\` URL and it was not installed from GitHub. Tell the human what went wrong instead.`);
    }
    const structuredContent = {
      kind: draft.kind,
      url: draft.url,
      prefilled: draft.prefill,
      truncated: draft.truncated,
      title: draft.title,
      body: draft.body,
      posted: false,
    };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
  },
};
