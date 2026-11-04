import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { repoStats, noteRepo, issuesAvailability, _setStatsSeamsForTests, STATS_TTL_MS, ERROR_TTL_MS } from './github-stats.js';

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

test('issuesAvailability: on, off, archived, missing, and unknown', async () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const answers = {
      'acme/on': () => ({ ok: true, json: async () => ({ ...ITEM, full_name: 'acme/on', has_issues: true }) }),
      'acme/off': () => ({ ok: true, json: async () => ({ ...ITEM, full_name: 'acme/off', has_issues: false }) }),
      'acme/old': () => ({ ok: true, json: async () => ({ ...ITEM, full_name: 'acme/old', archived: true }) }),
      'acme/gone': () => ({ ok: false, status: 404 }),
      'acme/limited': () => ({ ok: false, status: 403 }),
      'acme/offline': () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); },
    };
    _setStatsSeamsForTests({ fetch: async (url) => answers[url.replace('https://api.github.com/repos/', '')]() });
    const ask = (name, opts) => issuesAvailability({ owner: 'acme', repo: name }, opts);
    assert.deepEqual(await ask('on'), { available: true });
    assert.deepEqual(await ask('off'), { available: false, reason: 'Issues are turned off on the repository.' });
    assert.match((await ask('old')).reason, /archived/);
    assert.equal((await ask('old')).available, false);
    assert.equal((await ask('gone')).available, false);
    assert.match((await ask('gone')).reason, /may not exist, or be private/);
    // The repository the human installed from is reachable to them even when
    // GitHub hides it from an unauthenticated look.
    assert.equal((await ask('gone', { accessible: true })).available, null);
    assert.deepEqual(await ask('limited'), { available: null, reason: 'GitHub\'s rate limit was hit; try again later.' });
    assert.equal((await ask('offline')).available, null);
  } finally {
    console.log = original;
  }
  const logged = lines.filter((l) => l.includes('issues unavailable on'));
  assert.deepEqual(logged.map((l) => l.match(/on (acme\/\w+)/)[1]), ['acme/off', 'acme/old', 'acme/gone'], 'once per repository');
});

test('a catalog result with issues off answers availability with no request', async () => {
  const { asked } = seams([]);
  noteRepo({ ...ITEM, has_issues: false });
  assert.equal((await issuesAvailability(REPO)).available, false);
  assert.equal(asked.length, 0);
});
