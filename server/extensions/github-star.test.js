import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghLogin, isStarred, starRepo, unstarRepo } from './github-star.js';

const REPO = { owner: 'acme', repo: 'widgets-ext' };
const answer = (code, stdout = '', stderr = '') => async () => ({ code, stdout, stderr });

test('ghLogin reads the login from either output stream, and null when signed out or missing', async () => {
  assert.equal(await ghLogin(answer(0, 'github.com\n  ✓ Logged in to github.com account octo (keyring)\n')), 'octo');
  assert.equal(await ghLogin(answer(0, '', '✓ Logged in to github.com as octo-cat (oauth_token)')), 'octo-cat');
  assert.equal(await ghLogin(answer(0, 'something unexpected')), '', 'signed in, login unknown');
  assert.equal(await ghLogin(answer(1, '', 'You are not logged into any GitHub hosts.')), null);
  assert.equal(await ghLogin(async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); }), null);
});

test('isStarred reads 204 and 404 off the status line, and throws on anything else', async () => {
  assert.equal(await isStarred(REPO, answer(0, 'HTTP/2.0 204 No Content\r\n')), true);
  assert.equal(await isStarred(REPO, answer(1, 'HTTP/2.0 404 Not Found\n\n{}')), false);
  await assert.rejects(isStarred(REPO, answer(1, 'HTTP/2.0 401 Unauthorized\n', 'gh: Bad credentials (HTTP 401)')), /Bad credentials/);
  await assert.rejects(isStarred(REPO, answer(1, '', 'error connecting to api.github.com')), /error connecting/);
});

test('starRepo and unstarRepo send PUT and DELETE to the starred path', async () => {
  const calls = [];
  const gh = async (args) => {
    calls.push(args.join(' '));
    return args.includes('--method') ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: 'HTTP/2.0 404 Not Found\n', stderr: '' };
  };
  assert.deepEqual(await starRepo(REPO, gh), { starred: true });
  await unstarRepo(REPO, gh);
  assert.deepEqual(calls, [
    'api --hostname github.com --include user/starred/acme/widgets-ext',
    'api --hostname github.com --method PUT --silent user/starred/acme/widgets-ext',
    'api --hostname github.com --method DELETE --silent user/starred/acme/widgets-ext',
  ]);
  await assert.rejects(unstarRepo(REPO, answer(1, '', 'HTTP 403')), /HTTP 403/);
});
