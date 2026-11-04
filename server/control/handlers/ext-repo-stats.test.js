import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { extRepoStatsHandler } from './ext-repo-stats.js';
import { _setStatsSeamsForTests } from '../../extensions/github-stats.js';

afterEach(() => _setStatsSeamsForTests());

const LIST = [
  { id: 'widgets', external: true, provenance: { originUrl: 'git@github.com:acme/widgets-ext.git' } },
  { id: 'gitlab', external: true, provenance: { originUrl: 'https://gitlab.com/acme/gitlab-ext.git' } },
  { id: 'local', external: true, provenance: null, bugsUrl: 'https://github.com/acme/local-ext/issues' },
  { id: 'jira', external: false, provenance: null },
];

async function ask(id) {
  const replies = [];
  await extRepoStatsHandler.handler({ type: 'ext-repo-stats', id }, { ext: { list: LIST }, reply: (o) => replies.push(o) });
  return replies;
}

test('replies with stats for the repository the install recorded', async () => {
  const asked = [];
  _setStatsSeamsForTests({ fetch: async (url) => { asked.push(url); return { ok: true, json: async () => ({ full_name: 'acme/widgets-ext', stargazers_count: 5, open_issues_count: 2, html_url: 'https://github.com/acme/widgets-ext' }) }; } });
  assert.deepEqual(await ask('widgets'), [{ type: 'ext-repo-stats-result', id: 'widgets', stars: 5, openIssues: 2, htmlUrl: 'https://github.com/acme/widgets-ext' }]);
  assert.deepEqual(asked, ['https://api.github.com/repos/acme/widgets-ext']);
});

test('core, hand-placed, non-GitHub and unknown extensions get no stats and no request', async () => {
  _setStatsSeamsForTests({ fetch: async () => { throw new Error('must not fetch'); } });
  for (const id of ['jira', 'local', 'gitlab', 'nope']) {
    const [reply] = await ask(id);
    assert.equal(reply.id, id);
    assert.match(reply.error, /Not installed from a GitHub repository/);
    assert.equal(reply.stars, undefined);
  }
});

test('a GitHub failure is replied, not thrown', async () => {
  _setStatsSeamsForTests({ fetch: async () => ({ ok: false, status: 404 }) });
  const [reply] = await ask('widgets');
  assert.match(reply.error, /publicly/);
});
