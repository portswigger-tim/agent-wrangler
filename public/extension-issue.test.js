import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  githubRepoOf, parseIssuesRepo, issueRepoOf, statsRepoOf, extensionIssue, issueTitle, environmentLines, MAX_ISSUE_URL_LENGTH,
} from './extension-issue.js';

const ENV = { version: '1.2.3', codeVersion: 'abcdef0123456789', hostApi: '1.57.0', os: 'Darwin 25.6.0 (arm64)' };
const installed = {
  id: 'widgets', label: 'Widgets', external: true, origin: 'https://github.com/acme/widgets-ext.git',
  sha: '0123456789abcdef0123456789abcdef01234567', version: '2.0.1', range: '^1.31.0',
  enabled: true, quarantine: null, earlyAdopter: null, issuesRepo: '',
};
const core = { id: 'jira', label: 'Jira', external: false, origin: '', sha: '', version: '', enabled: true, quarantine: null, issuesRepo: '' };
const handPlaced = { id: 'local', label: 'Local', external: true, origin: '', sha: '', version: '0.0.1', enabled: true, issuesRepo: '' };

const params = (url) => new URL(url).searchParams;
const base = (url) => { const u = new URL(url); return `${u.origin}${u.pathname}`; };

test('githubRepoOf reads the three GitHub remote shapes and nothing else', () => {
  for (const url of ['https://github.com/acme/widgets-ext.git', 'https://github.com/acme/widgets-ext', 'git@github.com:acme/widgets-ext.git', 'ssh://git@github.com/acme/widgets-ext.git']) {
    assert.deepEqual(githubRepoOf(url), { owner: 'acme', repo: 'widgets-ext' }, url);
  }
  for (const url of ['https://gitlab.com/acme/widgets-ext.git', 'https://github.com/acme', 'http://github.com/acme/widgets-ext', '', null]) {
    assert.equal(githubRepoOf(url), null, String(url));
  }
});

test('parseIssuesRepo takes a GitHub owner/repo only', () => {
  assert.deepEqual(parseIssuesRepo('acme/widgets-issues'), { owner: 'acme', repo: 'widgets-issues' });
  assert.deepEqual(parseIssuesRepo('a-b9/re.po_x'), { owner: 'a-b9', repo: 're.po_x' });
  for (const bad of [
    'https://github.com/acme/widgets', 'acme', 'acme/', '/widgets', 'acme/widgets/issues', '-acme/x', 'acme-/x', 'ac--me/x',
    `${'a'.repeat(40)}/x`, `acme/${'r'.repeat(101)}`, 'acme/..', 'acme/.', 'ac me/x', 'acme/wid gets', 42, null, undefined, { owner: 'acme' },
  ]) assert.equal(parseIssuesRepo(bad), null, String(bad));
});

test('issueRepoOf: issuesRepo first, then the GitHub origin, then Agent Wrangler for core', () => {
  assert.deepEqual(issueRepoOf({ ...installed, issuesRepo: 'acme/all-issues' }), { owner: 'acme', repo: 'all-issues' });
  assert.deepEqual(issueRepoOf(installed), { owner: 'acme', repo: 'widgets-ext' });
  assert.deepEqual(issueRepoOf(core), { owner: 'PortSwigger', repo: 'agent-wrangler' });
  assert.deepEqual(issueRepoOf({ ...core, issuesRepo: 'acme/core-fork' }), { owner: 'acme', repo: 'core-fork' });
  assert.deepEqual(issueRepoOf({ ...handPlaced, issuesRepo: 'acme/local-ext' }), { owner: 'acme', repo: 'local-ext' });
});

test('no issue repo for a hand-placed or non-GitHub extension without issuesRepo', () => {
  assert.equal(issueRepoOf(handPlaced), null);
  assert.equal(issueRepoOf({ ...installed, origin: 'git@gitlab.example.com:acme/widgets-ext.git' }), null);
  assert.equal(issueRepoOf({ ...handPlaced, issuesRepo: 'not a repo' }), null, 'an invalid value is never used');
  assert.equal(extensionIssue(handPlaced, ENV), null);
});

test('stats only for an extension installed from GitHub, whatever its issuesRepo', () => {
  assert.deepEqual(statsRepoOf({ ...installed, issuesRepo: 'acme/all-issues' }), { owner: 'acme', repo: 'widgets-ext' });
  assert.equal(statsRepoOf(core), null);
  assert.equal(statsRepoOf({ ...handPlaced, issuesRepo: 'acme/local-ext' }), null);
  assert.equal(statsRepoOf({ ...installed, origin: 'https://gitlab.com/acme/widgets-ext.git' }), null);
});

test('the body carries the extension, its repository, wrangler, state and OS facts', () => {
  const draft = extensionIssue({ ...installed, earlyAdopter: { branch: 'next', enabled: true } }, ENV, { title: 'Crash on save', description: 'It crashed.', steps: '1. Save' });
  assert.equal(draft.repo, 'acme/widgets-ext');
  assert.equal(base(draft.url), 'https://github.com/acme/widgets-ext/issues/new');
  const p = params(draft.url);
  assert.equal(p.get('title'), '[widgets] Crash on save');
  const body = p.get('body');
  assert.equal(body, draft.body);
  assert.match(body, /It crashed\./);
  assert.match(body, /1\. Save/);
  assert.match(body, /Extension: `widgets` 2\.0\.1 \(installed from git\)/);
  assert.match(body, /Repository: acme\/widgets-ext/);
  assert.match(body, /Installed commit: `0123456789abcdef0123456789abcdef01234567` on `next` \(early adopter\)/);
  assert.match(body, /Agent Wrangler: 1\.2\.3 \(`abcdef0123456789`\)/);
  assert.match(body, /wranglerApi: 1\.57\.0, extension declares `\^1\.31\.0`/);
  assert.match(body, /State: enabled/);
  assert.match(body, /OS: Darwin 25\.6\.0 \(arm64\)/);
  assert.equal(draft.truncated, false);
});

test('a shared issues repo gets the extension id in the title and its origin in the body', () => {
  const draft = extensionIssue({ ...installed, issuesRepo: 'acme/all-issues' }, ENV, { title: 'Crash' });
  assert.equal(base(draft.url), 'https://github.com/acme/all-issues/issues/new');
  assert.equal(params(draft.url).get('title'), '[widgets] Crash');
  assert.match(draft.body, /Extension: `widgets`/);
  assert.match(draft.body, /Repository: acme\/widgets-ext/);
  // A hand-placed one names no repository, since it has none.
  assert.doesNotMatch(extensionIssue({ ...handPlaced, issuesRepo: 'acme/all-issues' }, ENV).body, /Repository:/);
});

test('state reads disabled or quarantined with the reason', () => {
  const lines = (e) => environmentLines(e, ENV).join('\n');
  assert.match(lines({ ...installed, enabled: false }), /State: disabled/);
  assert.match(lines({ ...installed, quarantine: 'bad manifest' }), /State: quarantined: bad manifest/);
  assert.match(lines({ ...installed, quarantine: 'x'.repeat(2000) }), /State: quarantined: x{500}…/);
  assert.match(lines({ ...installed, earlyAdopter: { branch: 'next', enabled: false } }), /on default branch/);
});

test('a core extension reports to Agent Wrangler, titled with its id', () => {
  const draft = extensionIssue(core, ENV, { title: 'Chip missing' });
  assert.equal(base(draft.url), 'https://github.com/PortSwigger/agent-wrangler/issues/new');
  assert.equal(params(draft.url).get('title'), '[jira] Chip missing');
  assert.match(draft.body, /Extension: `jira` \(core\)/);
  assert.doesNotMatch(draft.body, /Installed commit|Repository:/);
  assert.equal(issueTitle(core, '[jira] Chip missing'), '[jira] Chip missing', 'not prefixed twice');
});

test('an over-long report is cut to fit, keeping the environment', () => {
  const huge = 'é'.repeat(20000);
  const draft = extensionIssue(installed, ENV, { title: 'T', description: huge, steps: huge });
  assert.ok(draft.url.length <= MAX_ISSUE_URL_LENGTH, String(draft.url.length));
  assert.equal(draft.truncated, true);
  const body = params(draft.url).get('body');
  assert.match(body, /é…/);
  assert.match(body, /OS: Darwin/);
  // The full text is still returned for pasting.
  assert.ok(draft.body.length > 40000);
  // And it keeps as much of the description as fits, not a token amount.
  const kept = body.match(/### What happened\n\n(é*)…/)[1].length;
  assert.ok(kept > 100);
});

test('the kind defaults to bug, labels it, and an unknown kind is a bug', () => {
  for (const opts of [{}, { kind: 'bug' }, { kind: 'nonsense' }]) {
    const draft = extensionIssue(installed, ENV, { ...opts, title: 'T', description: 'D' });
    assert.equal(draft.kind, 'bug');
    assert.equal(params(draft.url).get('labels'), 'bug');
    assert.match(draft.body, /### What happened\n\nD/);
    assert.match(draft.body, /### Steps to reproduce/);
    assert.match(draft.body, /OS: Darwin/);
  }
});

test('a feature request has its own template, a shorter environment and the enhancement label', () => {
  const draft = extensionIssue(installed, ENV, { kind: 'feature', title: 'Dark chips', description: 'Chips in dark mode.', why: 'I work at night.', steps: 'ignored' });
  assert.equal(draft.kind, 'feature');
  const p = params(draft.url);
  assert.equal(p.get('labels'), 'enhancement');
  assert.equal(p.get('title'), '[widgets] Dark chips');
  assert.equal(p.get('body'), draft.body);
  assert.match(draft.body, /### What I'd like\n\nChips in dark mode\./);
  assert.match(draft.body, /### Why \/ what I was doing\n\nI work at night\./);
  assert.doesNotMatch(draft.body, /How it might look/, 'the optional section is left out when empty');
  assert.doesNotMatch(draft.body, /Steps to reproduce|ignored/, 'bug-only fields are not used');
  assert.match(draft.body, /Extension: `widgets` 2\.0\.1/);
  assert.match(draft.body, /Repository: acme\/widgets-ext/);
  assert.match(draft.body, /Agent Wrangler: 1\.2\.3/);
  for (const bugOnly of [/Installed commit/, /wranglerApi/, /State:/, /OS:/]) assert.doesNotMatch(draft.body, bugOnly);
  const sketched = extensionIssue(installed, ENV, { kind: 'feature', title: 'T', description: 'D', how: 'A toggle.' });
  assert.match(sketched.body, /### How it might look\n\nA toggle\./);
  assert.match(extensionIssue(installed, ENV, { kind: 'feature' }).body, /<!-- The change you would like/);
});

test('an over-long feature request is cut to fit too', () => {
  const huge = 'x'.repeat(20000);
  const draft = extensionIssue(installed, ENV, { kind: 'feature', title: 'T', description: huge, why: huge, how: huge });
  assert.ok(draft.url.length <= MAX_ISSUE_URL_LENGTH);
  assert.equal(draft.truncated, true);
  assert.match(params(draft.url).get('body'), /Agent Wrangler: 1\.2\.3/);
});
