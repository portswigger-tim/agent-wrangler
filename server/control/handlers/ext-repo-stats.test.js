import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { extRepoStatsHandler } from './ext-repo-stats.js';
import { _setStatsSeamsForTests } from '../../extensions/github-stats.js';

afterEach(() => _setStatsSeamsForTests());

const LIST = [
  { id: 'widgets', external: true, provenance: { originUrl: 'git@github.com:acme/widgets-ext.git' }, issuesRepo: '' },
  { id: 'shared', external: true, provenance: { originUrl: 'https://github.com/acme/shared-ext.git' }, issuesRepo: 'acme/all-issues' },
  { id: 'gitlab', external: true, provenance: { originUrl: 'https://gitlab.com/acme/gitlab-ext.git' }, issuesRepo: '' },
  { id: 'local', external: true, provenance: null, issuesRepo: 'acme/local-issues' },
  { id: 'bare', external: true, provenance: null, issuesRepo: '' },
  { id: 'jira', external: false, provenance: null, issuesRepo: '' },
];

const repo = (fullName, extra = {}) => ({ full_name: fullName, stargazers_count: 5, open_issues_count: 2, html_url: `https://github.com/${fullName}`, has_issues: true, ...extra });

function serve(answers) {
  const asked = [];
  _setStatsSeamsForTests({
    fetch: async (url) => {
      const name = url.replace('https://api.github.com/repos/', '');
      asked.push(name);
      const a = answers[name];
      if (!a) throw new Error(`unexpected fetch ${name}`);
      return a.status ? { ok: false, status: a.status } : { ok: true, json: async () => a };
    },
  });
  return asked;
}

async function ask(id) {
  const replies = [];
  await extRepoStatsHandler.handler({ type: 'ext-repo-stats', id }, { ext: { list: LIST }, reply: (o) => replies.push(o) });
  return replies[0];
}

test('stats and issue availability for an extension installed from GitHub, in one request', async () => {
  const asked = serve({ 'acme/widgets-ext': repo('acme/widgets-ext') });
  assert.deepEqual(await ask('widgets'), {
    type: 'ext-repo-stats-result', id: 'widgets',
    stats: { stars: 5, openIssues: 2, htmlUrl: 'https://github.com/acme/widgets-ext' },
    issues: { repo: 'acme/widgets-ext', available: true },
  });
  assert.deepEqual(asked, ['acme/widgets-ext']);
});

test('a shared issuesRepo is checked on its own; stats stay with the origin', async () => {
  serve({ 'acme/shared-ext': repo('acme/shared-ext'), 'acme/all-issues': repo('acme/all-issues', { has_issues: false }) });
  const r = await ask('shared');
  assert.equal(r.stats.htmlUrl, 'https://github.com/acme/shared-ext');
  assert.equal(r.issues.repo, 'acme/all-issues');
  assert.equal(r.issues.available, false);
});

test('core, hand-placed and non-GitHub extensions get no stats; their issue repo, if any, is still checked', async () => {
  const asked = serve({ 'PortSwigger/agent-wrangler': repo('PortSwigger/agent-wrangler'), 'acme/local-issues': { status: 404 } });
  const jira = await ask('jira');
  assert.equal(jira.stats, null);
  assert.deepEqual(jira.issues, { repo: 'PortSwigger/agent-wrangler', available: true });
  const local = await ask('local');
  assert.equal(local.stats, null);
  assert.equal(local.issues.available, false, 'not the install origin, so a 404 means it is not there for them');
  for (const id of ['gitlab', 'bare', 'nope']) {
    const r = await ask(id);
    assert.deepEqual([r.id, r.stats, r.issues], [id, null, null]);
  }
  assert.deepEqual(asked, ['PortSwigger/agent-wrangler', 'acme/local-issues']);
});

test('a private origin hides stats but keeps the links; a GitHub failure is replied, not thrown', async () => {
  serve({ 'acme/widgets-ext': { status: 404 } });
  const r = await ask('widgets');
  assert.equal(r.stats, null);
  assert.match(r.statsError, /publicly/);
  assert.equal(r.issues.available, null, 'they cloned it, so it is not known to be missing');
});
