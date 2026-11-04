import { z } from 'zod';
import { extensionsForGraph } from '../../extensions/index.js';
import { HOST_API_VERSION } from '../../host-api/version.js';
import { VERSION, platformText } from '../../version.js';
import { extensionIssue } from '../../../public/extension-issue.js';

const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

// Drafts an issue about an extension, for the human to review and submit. The
// URL is built by public/extension-issue.js, the same code as the Settings →
// Extensions "Report an issue" button, from the same facts. Nothing is posted:
// this returns a link and never calls GitHub.
export const reportExtensionIssueTool = {
  name: 'report_extension_issue',
  description:
    'Draft an issue about an Agent Wrangler extension that misbehaved, for the human to review and submit. '
    + 'Returns a pre-filled new-issue URL on the extension\'s tracker (its package.json `bugs`, Agent Wrangler\'s '
    + 'own repository for a core extension, or the GitHub repository it was installed from). The body adds the '
    + 'extension version, installed commit and branch, Agent Wrangler version, host API, enabled or quarantine '
    + 'state, and OS. It posts nothing: give the URL to the human to open. Never file the issue yourself with '
    + '`gh issue create` or the API. When `prefilled` is false, or `truncated` is true, also give the human the '
    + 'returned `title` and `body` to paste. Read the report-extension-issue skill first.',
  inputSchema: {
    extensionId: z.string().min(1).describe('The extension id, as Settings → Extensions or the extension\'s own tools name it.'),
    title: z.string().min(1).max(200).describe('A short summary of the problem.'),
    description: z.string().min(1).describe('What happened and what you expected instead, with any error text. No secrets, tokens or private paths.'),
    steps: z.string().optional().describe('Numbered steps that reproduce it, if known.'),
  },
  async handler({ deps }, args = {}) {
    const entries = extensionsForGraph(deps.ext?.list || []);
    const entry = entries.find((e) => e.id === args.extensionId);
    if (!entry) {
      return errorResult(`Unknown extension "${args.extensionId}". Installed extensions: ${entries.map((e) => e.id).join(', ') || '(none)'}.`);
    }
    const env = { version: VERSION, codeVersion: deps.graph?.()?.codeVersion || '', hostApi: HOST_API_VERSION, os: platformText() };
    const draft = extensionIssue(entry, env, { title: args.title, description: args.description, steps: args.steps || '' });
    if (!draft) {
      return errorResult(`Extension "${entry.id}" names no issue tracker: its package.json has no https:// \`bugs\` URL and it was not installed from GitHub. Tell the human what went wrong instead.`);
    }
    const structuredContent = {
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
