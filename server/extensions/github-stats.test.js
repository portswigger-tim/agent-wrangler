import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { repoStats, noteRepo, issuesAvailability, openIssueCount, _setStatsSeamsForTests, STATS_TTL_MS, ERROR_TTL_MS } from './github-stats.js';

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
  assert.deepEqual(await repoStats(REPO), { stars: 12, htmlUrl: ITEM.html_url }, 'no open_issues_count: it counts pull requests too');
  assert.equal((await repoStats({ owner: 'ACME', repo: 'Widgets-Ext' })).stars, 12);
  assert.deepEqual(asked, ['https://api.github.com/repos/acme/widgets-ext']);
  advance(STATS_TTL_MS);
  assert.equal((await repoStats(REPO)).stars, 13);
  assert.equal(asked.length, 2);
});

test('a catalog result seeds the cache, so no request is made', async () => {
  const { asked } = seams([]);
  noteRepo(ITEM);
  assert.equal((await repoStats(REPO)).stars, 12);
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

// --- openIssueCount ---------------------------------------------------------

const API = 'https://api.github.com/';
const json = (body, headers = {}) => ({ ok: true, headers: new Headers(headers), json: async () => body });
const lastPage = (n) => ({ link: `<${API}repositories/1/pulls?state=open&per_page=1&page=2>; rel="next", <${API}repositories/1/pulls?state=open&per_page=1&page=${n}>; rel="last"` });

// Fetch answers by path, and a `gh` that answers GraphQL or is signed out.
function countSeams({ answers = {}, gh = null } = {}) {
  let t = 0;
  const asked = [];
  const ghCalls = [];
  _setStatsSeamsForTests({
    fetch: async (url) => {
      const path = url.replace(API, '');
      asked.push(path);
      const a = answers[path];
      if (!a) throw new Error(`unexpected fetch ${path}`);
      return a();
    },
    gh: gh && (async (args) => { ghCalls.push(args); return gh(args); }),
    clock: () => t,
  });
  return { asked, ghCalls, advance: (ms) => { t += ms; } };
}

test('signed in to gh: the GraphQL count of open issues, with no REST request', async () => {
  const { asked, ghCalls } = countSeams({ gh: async () => ({ code: 0, stdout: JSON.stringify({ data: { repository: { issues: { totalCount: 4 } } } }), stderr: '' }) });
  assert.equal(await openIssueCount(REPO), 4);
  assert.equal(asked.length, 0);
  const args = ghCalls[0];
  assert.deepEqual(args.slice(0, 4), ['api', 'graphql', '--hostname', 'github.com']);
  assert.match(args.join(' '), /issues\(states:OPEN\)\{totalCount\}/);
  assert.ok(args.includes('owner=acme') && args.includes('name=widgets-ext'));
  assert.equal(await openIssueCount(REPO), 4);
  assert.equal(ghCalls.length, 1, 'cached');
});

test('signed out: open_issues_count less the open pull requests, from the Link header', async () => {
  const { asked } = countSeams({ answers: {
    'repos/acme/widgets-ext': () => json({ ...ITEM, open_issues_count: 10 }),
    'repos/acme/widgets-ext/pulls?state=open&per_page=1': () => json([{ number: 9 }], lastPage(7)),
  } });
  assert.equal(await openIssueCount(REPO), 3);
  assert.deepEqual(asked, ['repos/acme/widgets-ext', 'repos/acme/widgets-ext/pulls?state=open&per_page=1']);
});

test('no Link header means every open pull request fit on the one page: 0 or 1', async () => {
  for (const [pulls, expected] of [[[], 3], [[{ number: 1 }], 2]]) {
    countSeams({ answers: {
      'repos/acme/widgets-ext/pulls?state=open&per_page=1': () => json(pulls),
    } });
    noteRepo(ITEM);
    assert.equal(await openIssueCount(REPO), expected);
  }
  // Read at different moments, the two numbers never make a negative count.
  countSeams({ answers: { 'repos/acme/widgets-ext/pulls?state=open&per_page=1': () => json([], lastPage(5)) } });
  noteRepo(ITEM);
  assert.equal(await openIssueCount(REPO), 0);
});

test('no count at all when neither way works, cached for the shorter time', async () => {
  const { asked, advance } = countSeams({
    gh: async () => ({ code: 1, stdout: '', stderr: 'HTTP 502' }),
    answers: {
      'repos/acme/widgets-ext': () => json({ ...ITEM, open_issues_count: 10 }),
      'repos/acme/widgets-ext/pulls?state=open&per_page=1': () => ({ ok: false, status: 403, headers: new Headers() }),
    },
  });
  assert.equal(await openIssueCount(REPO), null, 'never open_issues_count on its own');
  assert.equal(await openIssueCount(REPO), null);
  assert.equal(asked.filter((p) => p.includes('pulls')).length, 1);
  advance(ERROR_TTL_MS);
  await openIssueCount(REPO);
  assert.equal(asked.filter((p) => p.includes('pulls')).length, 2);
  // Offline, or the repository itself out of reach, hides it too.
  countSeams({ answers: {
    'repos/acme/widgets-ext': () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); },
  } });
  assert.equal(await openIssueCount(REPO), null);
  // As does a `gh` that is not installed, or answers something else.
  for (const gh of [async () => { throw new Error('spawn gh ENOENT'); }, async () => ({ code: 0, stdout: 'not json', stderr: '' })]) {
    countSeams({ gh, answers: { 'repos/acme/widgets-ext': () => ({ ok: false, status: 429 }) } });
    assert.equal(await openIssueCount(REPO), null);
  }
});

const SHARED = { owner: 'acme', repo: 'all-issues' };
const SEARCH = 'is:issue is:open "[widgets]" in:title';

test('a shared issues repository: issue search for the extension\'s titles, through gh or not', async () => {
  const { ghCalls } = countSeams({ gh: async () => ({ code: 0, stdout: JSON.stringify({ data: { search: { issueCount: 2 } } }), stderr: '' }) });
  assert.equal(await openIssueCount(SHARED, { search: SEARCH }), 2);
  assert.match(ghCalls[0].join(' '), /search\(query:\$q,type:ISSUE\)\{issueCount\}/);
  assert.ok(ghCalls[0].includes(`q=repo:acme/all-issues ${SEARCH}`));

  const q = `search/issues?q=${encodeURIComponent(`repo:acme/all-issues ${SEARCH}`)}&per_page=1`;
  const { asked } = countSeams({ answers: { [q]: () => json({ total_count: 5, items: [] }) } });
  assert.equal(await openIssueCount(SHARED, { search: SEARCH }), 5);
  assert.deepEqual(asked, [q], 'not the whole repository\'s count');
  // Cached apart from the whole repository's count.
  assert.equal(await openIssueCount(SHARED, { search: SEARCH }), 5);
  assert.equal(asked.length, 1);

  countSeams({ answers: { [q]: () => ({ ok: false, status: 403, headers: new Headers() }) } });
  assert.equal(await openIssueCount(SHARED, { search: SEARCH }), null, 'search\'s own rate limit hides it');
});
