import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { repoStats, noteRepo, _setStatsSeamsForTests, STATS_TTL_MS, ERROR_TTL_MS } from './github-stats.js';

const REPO = { owner: 'acme', repo: 'widgets-ext' };
const ITEM = { full_name: 'acme/widgets-ext', stargazers_count: 12, open_issues_count: 3, html_url: 'https://github.com/acme/widgets-ext' };

afterEach(() => _setStatsSeamsForTests());

function seams(responses) {
  let t = 0;
  const asked = [];
  _setStatsSeamsForTests({
    fetch: async (url) => { asked.push(url); return responses.shift()(); },
    clock: () => t,
  });
  return { asked, advance: (ms) => { t += ms; } };
}

test('fetches the repository once and serves the cache until it expires', async () => {
  const { asked, advance } = seams([() => ({ ok: true, json: async () => ITEM }), () => ({ ok: true, json: async () => ({ ...ITEM, stargazers_count: 13 }) })]);
  assert.deepEqual(await repoStats(REPO), { stars: 12, openIssues: 3, htmlUrl: ITEM.html_url });
  assert.equal((await repoStats({ owner: 'ACME', repo: 'Widgets-Ext' })).stars, 12);
  assert.deepEqual(asked, ['https://api.github.com/repos/acme/widgets-ext']);
  advance(STATS_TTL_MS);
  assert.equal((await repoStats(REPO)).stars, 13);
  assert.equal(asked.length, 2);
});

test('a catalog result seeds the cache, so no request is made', async () => {
  const { asked } = seams([]);
  noteRepo(ITEM);
  assert.equal((await repoStats(REPO)).openIssues, 3);
  assert.equal(asked.length, 0);
});

test('a failure is cached for less time, and an off-GitHub html_url is dropped', async () => {
  const { asked, advance } = seams([() => ({ ok: false, status: 403 }), () => ({ ok: true, json: async () => ({ ...ITEM, html_url: 'https://evil.example.com/x' }) })]);
  await assert.rejects(repoStats(REPO), /rate limit/);
  await assert.rejects(repoStats(REPO), /rate limit/);
  assert.equal(asked.length, 1);
  advance(ERROR_TTL_MS);
  assert.equal((await repoStats(REPO)).htmlUrl, '');
});
