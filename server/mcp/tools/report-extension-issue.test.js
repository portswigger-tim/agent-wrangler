import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reportExtensionIssueTool } from './report-extension-issue.js';
import { extensionIssue } from '../../../public/extension-issue.js';
import { extensionsForGraph } from '../../extensions/index.js';
import { HOST_API_VERSION } from '../../host-api/version.js';
import { VERSION, platformText } from '../../version.js';
import { _setStatsSeamsForTests } from '../../extensions/github-stats.js';

const LIST = [
  {
    id: 'widgets', label: 'Widgets', defaultEnabled: true, enabled: true, external: true, version: '2.0.1', issuesRepo: '', range: '^1.31.0',
    provenance: { originUrl: 'https://github.com/acme/widgets-ext.git', sha: '0123456789abcdef', earlyAdopter: true }, earlyAdopterBranch: 'next',
  },
  { id: 'jira', label: 'Jira', defaultEnabled: true, enabled: true, external: false, provenance: null },
  { id: 'local', label: 'Local', defaultEnabled: true, enabled: true, external: true, provenance: null, version: '0.0.1', issuesRepo: '' },
  { id: 'shared', label: 'Shared', defaultEnabled: true, enabled: true, external: true, provenance: { originUrl: 'https://github.com/acme/shared-ext.git' }, issuesRepo: 'acme/all-issues' },
];
const deps = { ext: { list: LIST }, graph: () => ({ codeVersion: 'abc1234' }) };
const call = (args) => reportExtensionIssueTool.handler({ deps, caller: 'card-1' }, args);
const env = { version: VERSION, codeVersion: 'abc1234', hostApi: HOST_API_VERSION, os: platformText() };
const entryOf = (id) => extensionsForGraph(LIST).find((e) => e.id === id);

// GitHub, stubbed: every repository takes issues unless listed otherwise.
function github(overrides = {}) {
  const asked = [];
  _setStatsSeamsForTests({
    fetch: async (url) => {
      const name = url.replace('https://api.github.com/repos/', '');
      asked.push(name);
      const o = overrides[name];
      if (o instanceof Error) throw o;
      if (o?.status) return { ok: false, status: o.status };
      return { ok: true, json: async () => ({ full_name: name, has_issues: true, ...o }) };
    },
  });
  return asked;
}
afterEach(() => _setStatsSeamsForTests());

test('returns the same pre-filled URL the links build, and posts nothing', async () => {
  github();
  const args = { extensionId: 'widgets', title: 'Crash on save', description: 'It crashed.', steps: '1. Save' };
  const out = await call(args);
  assert.equal(out.isError, undefined);
  const r = out.structuredContent;
  assert.deepEqual(JSON.parse(out.content[0].text), r);
  assert.equal(r.url, extensionIssue(entryOf('widgets'), env, { title: args.title, description: args.description, steps: args.steps }).url);
  assert.ok(r.url.startsWith('https://github.com/acme/widgets-ext/issues/new?title=%5Bwidgets%5D%20Crash%20on%20save&body='));
  assert.equal(r.available, true);
  assert.equal(r.unconfirmed, undefined);
  assert.equal(r.repo, 'acme/widgets-ext');
  assert.equal(r.truncated, false);
  assert.equal(r.posted, false);
  assert.equal(r.kind, 'bug', 'bug is the default');
  assert.equal(new URL(r.url).searchParams.get('labels'), 'bug');
  assert.match(r.body, /`next` \(early adopter\)/);
  assert.match(r.body, new RegExp(`wranglerApi: ${HOST_API_VERSION.replace(/\./g, '\\.')}`));
});

test('kind "feature" drafts a feature request with the same builder as the links', async () => {
  github();
  const args = { kind: 'feature', extensionId: 'widgets', title: 'Dark chips', description: 'Chips in dark mode.', why: 'I work at night.', how: 'A toggle.' };
  const r = (await call(args)).structuredContent;
  assert.equal(r.url, extensionIssue(entryOf('widgets'), env, args).url);
  assert.equal(r.kind, 'feature');
  assert.equal(new URL(r.url).searchParams.get('labels'), 'enhancement');
  assert.match(r.body, /### What I'd like\n\nChips in dark mode\./);
  assert.match(r.body, /### How it might look\n\nA toggle\./);
  assert.doesNotMatch(r.body, /OS:/);
  assert.ok(reportExtensionIssueTool.inputSchema.kind.safeParse(undefined).success, 'kind is optional');
  assert.equal(reportExtensionIssueTool.inputSchema.kind.safeParse('chore').success, false);
});

test('a core extension reports to Agent Wrangler; a shared issuesRepo is used and checked', async () => {
  const asked = github();
  const core = (await call({ extensionId: 'jira', title: 'Chip missing', description: 'No chip.' })).structuredContent;
  assert.ok(core.url.startsWith('https://github.com/PortSwigger/agent-wrangler/issues/new?'));
  assert.equal(core.title, '[jira] Chip missing');
  const shared = (await call({ extensionId: 'shared', title: 'T', description: 'D' })).structuredContent;
  assert.equal(shared.repo, 'acme/all-issues');
  assert.match(shared.body, /Repository: acme\/shared-ext/);
  assert.deepEqual(asked, ['PortSwigger/agent-wrangler', 'acme/all-issues']);
});

test('no issue repo, or issues turned off, is an answer with a reason, not an error', async () => {
  github({ 'acme/all-issues': { has_issues: false } });
  const none = await call({ extensionId: 'local', title: 'T', description: 'D' });
  assert.equal(none.isError, undefined);
  assert.equal(none.structuredContent.available, false);
  assert.match(none.structuredContent.reason, /has no issue repo/);
  assert.equal(none.structuredContent.url, undefined);
  const off = (await call({ extensionId: 'shared', title: 'T', description: 'D' })).structuredContent;
  assert.deepEqual(off, { available: false, repo: 'acme/all-issues', reason: 'Issues are turned off on the repository.', posted: false });
});

test('when GitHub cannot be asked, the URL is still returned, marked unconfirmed', async () => {
  github({ 'acme/widgets-ext': new Error('getaddrinfo ENOTFOUND api.github.com') });
  const r = (await call({ extensionId: 'widgets', title: 'T', description: 'D' })).structuredContent;
  assert.equal(r.available, true);
  assert.match(r.unconfirmed, /ENOTFOUND/);
  assert.ok(r.url);
});

test('an unknown extension is an error', async () => {
  const unknown = await call({ extensionId: 'nope', title: 'T', description: 'D' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Installed extensions: widgets, jira, local, shared/);
});
