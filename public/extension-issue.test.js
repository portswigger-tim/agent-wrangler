import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  githubRepoOf, bugsUrlOf, issueTarget, statsRepoOf, extensionIssue, issueTitle, environmentLines, MAX_ISSUE_URL_LENGTH,
} from './extension-issue.js';

const ENV = { version: '1.2.3', codeVersion: 'abcdef0123456789', hostApi: '1.57.0', os: 'Darwin 25.6.0 (arm64)' };
const installed = {
  id: 'widgets', label: 'Widgets', external: true, origin: 'https://github.com/acme/widgets-ext.git',
  sha: '0123456789abcdef0123456789abcdef01234567', version: '2.0.1', range: '^1.31.0',
  enabled: true, quarantine: null, earlyAdopter: null, bugsUrl: '',
};
const core = { id: 'jira', label: 'Jira', external: false, origin: '', sha: '', version: '', enabled: true, quarantine: null };
const handPlaced = { id: 'local', label: 'Local', external: true, origin: '', sha: '', version: '0.0.1', enabled: true, bugsUrl: '' };

const params = (url) => new URL(url).searchParams;

test('githubRepoOf reads the three GitHub remote shapes and nothing else', () => {
  for (const url of ['https://github.com/acme/widgets-ext.git', 'https://github.com/acme/widgets-ext', 'git@github.com:acme/widgets-ext.git', 'ssh://git@github.com/acme/widgets-ext.git']) {
    assert.deepEqual(githubRepoOf(url), { owner: 'acme', repo: 'widgets-ext' }, url);
  }
  for (const url of ['https://gitlab.com/acme/widgets-ext.git', 'https://github.com/acme', 'http://github.com/acme/widgets-ext', '', null]) {
    assert.equal(githubRepoOf(url), null, String(url));
  }
});

test('bugsUrlOf honours a string or { url } and only https://', () => {
  assert.equal(bugsUrlOf('https://github.com/acme/widgets-ext/issues'), 'https://github.com/acme/widgets-ext/issues');
  assert.equal(bugsUrlOf({ url: 'https://tracker.example.com/widgets', email: 'a@example.com' }), 'https://tracker.example.com/widgets');
  for (const bad of ['http://example.com/bugs', 'javascript:alert(1)', 'not a url', { email: 'a@example.com' }, 42, null, undefined]) {
    assert.equal(bugsUrlOf(bad), '', String(bad));
  }
});

test('issueTarget prefers bugs, then core, then a GitHub origin', () => {
  assert.deepEqual(issueTarget(installed), { url: 'https://github.com/acme/widgets-ext/issues/new', prefill: true, repo: { owner: 'acme', repo: 'widgets-ext' } });
  assert.equal(issueTarget(core).url, 'https://github.com/PortSwigger/agent-wrangler/issues/new');
  const fork = { ...installed, bugsUrl: 'https://github.com/acme/widgets-tracker/issues' };
  assert.equal(issueTarget(fork).url, 'https://github.com/acme/widgets-tracker/issues/new');
  const templated = { ...installed, bugsUrl: 'https://github.com/acme/widgets-ext/issues/new?template=bug.md' };
  assert.equal(issueTarget(templated).url, 'https://github.com/acme/widgets-ext/issues/new?template=bug.md');
  const elsewhere = { ...installed, bugsUrl: 'https://tracker.example.com/widgets' };
  assert.deepEqual(issueTarget(elsewhere), { url: 'https://tracker.example.com/widgets', prefill: false, repo: null });
});

test('no target without bugs or a GitHub origin', () => {
  assert.equal(issueTarget(handPlaced), null);
  assert.equal(issueTarget({ ...installed, origin: 'git@gitlab.example.com:acme/widgets-ext.git' }), null);
  assert.equal(extensionIssue(handPlaced, ENV), null);
  // A hand-placed extension gets a target from its own bugs field.
  assert.equal(issueTarget({ ...handPlaced, bugsUrl: 'https://github.com/acme/local-ext/issues' }).url, 'https://github.com/acme/local-ext/issues/new');
});

test('stats only for an extension installed from GitHub', () => {
  assert.deepEqual(statsRepoOf(installed), { owner: 'acme', repo: 'widgets-ext' });
  assert.equal(statsRepoOf(core), null);
  assert.equal(statsRepoOf(handPlaced), null);
  assert.equal(statsRepoOf({ ...handPlaced, bugsUrl: 'https://github.com/acme/local-ext/issues' }), null);
  assert.equal(statsRepoOf({ ...installed, origin: 'https://gitlab.com/acme/widgets-ext.git' }), null);
});

test('the body carries the extension, wrangler, state and OS facts', () => {
  const draft = extensionIssue({ ...installed, earlyAdopter: { branch: 'next', enabled: true } }, ENV, { title: 'Crash on save', description: 'It crashed.', steps: '1. Save' });
  const p = params(draft.url);
  assert.equal(p.get('title'), 'Crash on save');
  const body = p.get('body');
  assert.equal(body, draft.body);
  assert.match(body, /It crashed\./);
  assert.match(body, /1\. Save/);
  assert.match(body, /Extension: `widgets` 2\.0\.1 \(installed from git\)/);
  assert.match(body, /Installed commit: `0123456789abcdef0123456789abcdef01234567` on `next` \(early adopter\)/);
  assert.match(body, /Agent Wrangler: 1\.2\.3 \(`abcdef0123456789`\)/);
  assert.match(body, /wranglerApi: 1\.57\.0, extension declares `\^1\.31\.0`/);
  assert.match(body, /State: enabled/);
  assert.match(body, /OS: Darwin 25\.6\.0 \(arm64\)/);
  assert.equal(draft.truncated, false);
});

test('state reads disabled or quarantined with the reason', () => {
  const lines = (e) => environmentLines(e, ENV).join('\n');
  assert.match(lines({ ...installed, enabled: false }), /State: disabled/);
  assert.match(lines({ ...installed, quarantine: 'bad manifest' }), /State: quarantined: bad manifest/);
  assert.match(lines({ ...installed, quarantine: 'x'.repeat(2000) }), /State: quarantined: x{500}…/);
  assert.match(lines({ ...installed, earlyAdopter: { branch: 'next', enabled: false } }), /on default branch/);
});

test('a core extension is named in the title and reports to Agent Wrangler', () => {
  const draft = extensionIssue(core, ENV, { title: 'Chip missing' });
  assert.ok(draft.url.startsWith('https://github.com/PortSwigger/agent-wrangler/issues/new?'));
  assert.equal(params(draft.url).get('title'), '[Jira] Chip missing');
  assert.match(draft.body, /Extension: `jira` \(core\)/);
  assert.doesNotMatch(draft.body, /Installed commit/);
  assert.equal(issueTitle(core, '[Jira] Chip missing'), '[Jira] Chip missing');
});

test('a non-GitHub tracker opens as it is, with the text returned to paste', () => {
  const draft = extensionIssue({ ...installed, bugsUrl: 'https://tracker.example.com/widgets' }, ENV, { title: 'T', description: 'D' });
  assert.equal(draft.url, 'https://tracker.example.com/widgets');
  assert.equal(draft.prefill, false);
  assert.match(draft.body, /D/);
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

test('keeps an existing query on a templated bugs URL', () => {
  const draft = extensionIssue({ ...installed, bugsUrl: 'https://github.com/acme/widgets-ext/issues/new?template=bug.md' }, ENV, { title: 'T' });
  const p = params(draft.url);
  assert.equal(p.get('template'), 'bug.md');
  assert.equal(p.get('title'), 'T');
});
