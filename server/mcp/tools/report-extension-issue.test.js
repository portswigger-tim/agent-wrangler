import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportExtensionIssueTool } from './report-extension-issue.js';
import { extensionIssue } from '../../../public/extension-issue.js';
import { extensionsForGraph } from '../../extensions/index.js';
import { HOST_API_VERSION } from '../../host-api/version.js';
import { VERSION, platformText } from '../../version.js';

const LIST = [
  {
    id: 'widgets', label: 'Widgets', defaultEnabled: true, enabled: true, external: true, version: '2.0.1', bugsUrl: '', range: '^1.31.0',
    provenance: { originUrl: 'https://github.com/acme/widgets-ext.git', sha: '0123456789abcdef', earlyAdopter: true }, earlyAdopterBranch: 'next',
  },
  { id: 'jira', label: 'Jira', defaultEnabled: true, enabled: true, external: false, provenance: null },
  { id: 'local', label: 'Local', defaultEnabled: true, enabled: true, external: true, provenance: null, version: '0.0.1', bugsUrl: '' },
  { id: 'elsewhere', label: 'Elsewhere', defaultEnabled: true, enabled: true, external: true, provenance: null, bugsUrl: 'https://tracker.example.com/elsewhere' },
];
const deps = { ext: { list: LIST }, graph: () => ({ codeVersion: 'abc1234' }) };
const call = (args) => reportExtensionIssueTool.handler({ deps, caller: 'card-1' }, args);

test('returns the same pre-filled URL the button builds, and posts nothing', async () => {
  const args = { extensionId: 'widgets', title: 'Crash on save', description: 'It crashed.', steps: '1. Save' };
  const out = await call(args);
  assert.equal(out.isError, undefined);
  const r = out.structuredContent;
  assert.deepEqual(JSON.parse(out.content[0].text), r);
  const entry = extensionsForGraph(LIST).find((e) => e.id === 'widgets');
  const env = { version: VERSION, codeVersion: 'abc1234', hostApi: HOST_API_VERSION, os: platformText() };
  assert.equal(r.url, extensionIssue(entry, env, { title: args.title, description: args.description, steps: args.steps }).url);
  assert.ok(r.url.startsWith('https://github.com/acme/widgets-ext/issues/new?title=Crash%20on%20save&body='));
  assert.equal(r.prefilled, true);
  assert.equal(r.truncated, false);
  assert.equal(r.posted, false);
  assert.match(r.body, /`next` \(early adopter\)/);
  assert.match(r.body, new RegExp(`wranglerApi: ${HOST_API_VERSION.replace(/\./g, '\\.')}`));
});

test('a core extension reports to Agent Wrangler\'s own repository', async () => {
  const r = (await call({ extensionId: 'jira', title: 'Chip missing', description: 'No chip.' })).structuredContent;
  assert.ok(r.url.startsWith('https://github.com/PortSwigger/agent-wrangler/issues/new?'));
  assert.equal(r.title, '[Jira] Chip missing');
});

test('a non-GitHub tracker comes back unfilled with the text to paste', async () => {
  const r = (await call({ extensionId: 'elsewhere', title: 'T', description: 'D' })).structuredContent;
  assert.equal(r.url, 'https://tracker.example.com/elsewhere');
  assert.equal(r.prefilled, false);
  assert.match(r.body, /### What happened\n\nD/);
});

test('an unknown extension or one with no tracker is an error', async () => {
  const unknown = await call({ extensionId: 'nope', title: 'T', description: 'D' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Installed extensions: widgets, jira, local, elsewhere/);
  const none = await call({ extensionId: 'local', title: 'T', description: 'D' });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /names no issue tracker/);
});
