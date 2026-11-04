import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasModelLine, hasExtensionsLine, withFooter, fetchFooterFacts, tagPr, runModelFooter } from './pr-footer.js';

const withModelFooter = (body, model) => withFooter(body, { model });
const fetchFooterModel = async (opts) => (await fetchFooterFacts(opts)).model;

const PR = 'https://github.com/acme/widgets/pull/7';

// A gh stand-in: answers `pr view` with `body` and records every call.
function fakeGh(body) {
  const calls = [];
  const gh = async (args, input) => {
    calls.push({ args, input });
    return args[1] === 'view' ? `${body}\n` : '';
  };
  return { gh, calls };
}

const json = (value, ok = true) => async () => ({ ok, json: async () => value });

test('hasModelLine finds a Model line anywhere in the body, and only at a line start', () => {
  assert.equal(hasModelLine('Summary\n\nModel: claude-opus-5-5'), true);
  assert.equal(hasModelLine('Model: gpt-5.5\n\nmore'), true);
  assert.equal(hasModelLine('The Model: field is not a footer'), false);
  assert.equal(hasModelLine('Model:'), false);
  assert.equal(hasModelLine(null), false);
});

test('withFooter (model only) appends one blank line then the footer, trimming trailing space', () => {
  assert.equal(withModelFooter('Summary\n\n🤖 Generated\n\n', 'claude-opus-5-5'), 'Summary\n\n🤖 Generated\n\nModel: claude-opus-5-5');
  assert.equal(withModelFooter('', 'claude-opus-5-5'), 'Model: claude-opus-5-5');
});

test('withFooter (model only) leaves a body that already names a model, or has no model to add', () => {
  assert.equal(withModelFooter('Summary\n\nModel: claude-sonnet-5-5', 'claude-opus-5-5'), null);
  assert.equal(withModelFooter('Summary', null), null);
});

test('tagPr reads the body and writes the footered body through --body-file stdin', async () => {
  const { gh, calls } = fakeGh('Summary');
  assert.equal(await tagPr({ prUrl: PR, model: 'claude-opus-5-5', gh }), 'tagged');
  assert.deepEqual(calls[0].args, ['pr', 'view', PR, '--json', 'body', '--jq', '.body']);
  assert.deepEqual(calls[1].args, ['pr', 'edit', PR, '--body-file', '-']);
  assert.equal(calls[1].input, 'Summary\n\nModel: claude-opus-5-5');
});

test('tagPr never edits a body that already has a Model line', async () => {
  const { gh, calls } = fakeGh('Summary\n\nModel: claude-sonnet-5-5');
  assert.equal(await tagPr({ prUrl: PR, model: 'claude-opus-5-5', gh }), 'present');
  assert.equal(calls.length, 1);
});

test('tagPr without a model touches nothing', async () => {
  const { gh, calls } = fakeGh('Summary');
  assert.equal(await tagPr({ prUrl: PR, model: null, gh }), 'skipped');
  assert.equal(calls.length, 0);
});

test('fetchFooterFacts POSTs the session id and returns the model, or null', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ model: 'claude-opus-5-5' }) }; };
  assert.equal(await fetchFooterModel({ url: 'http://127.0.0.1:1/pr-model', session: 'CARD', fetchImpl }), 'claude-opus-5-5');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers['X-AW-Session'], 'CARD');
  assert.equal(await fetchFooterModel({ url: 'u', session: 'CARD', fetchImpl: json({ model: null }) }), null);
  assert.equal(await fetchFooterModel({ url: 'u', session: 'CARD', fetchImpl: json({}, false) }), null);
  assert.equal(await fetchFooterModel({ url: null, session: 'CARD', fetchImpl: json({ model: 'x' }) }), null);
});

test('runModelFooter: setting off (server answers null) leaves the PR untouched', async () => {
  const { gh, calls } = fakeGh('Summary');
  const env = { AW_PR_MODEL_URL: 'u', AW_SESSION_ID: 'CARD' };
  assert.equal(await runModelFooter({ prUrl: PR, env, fetchImpl: json({ model: null }), gh }), 'skipped');
  assert.equal(calls.length, 0);
});

test('runModelFooter: setting on tags the PR with the session model', async () => {
  const { gh, calls } = fakeGh('Summary');
  const env = { AW_PR_MODEL_URL: 'u', AW_SESSION_ID: 'CARD' };
  assert.equal(await runModelFooter({ prUrl: PR, env, fetchImpl: json({ model: 'gpt-5.5' }), gh }), 'tagged');
  assert.equal(calls[1].input, 'Summary\n\nModel: gpt-5.5');
});

test('hasExtensionsLine finds an Extensions line only at a line start', () => {
  assert.equal(hasExtensionsLine('Summary\n\nExtensions: acme/widgets-ext'), true);
  assert.equal(hasExtensionsLine('These Extensions: are prose'), false);
  assert.equal(hasExtensionsLine('Extensions:'), false);
});

test('withFooter puts Model and Extensions on consecutive lines after one blank line', () => {
  assert.equal(
    withFooter('Summary\n', { model: 'claude-opus-5-5', extensions: ['acme/widgets-ext', 'acme/gadgets-ext'] }),
    'Summary\n\nModel: claude-opus-5-5\nExtensions: acme/widgets-ext, acme/gadgets-ext',
  );
  assert.equal(withFooter('Summary', { extensions: ['acme/widgets-ext'] }), 'Summary\n\nExtensions: acme/widgets-ext');
  assert.equal(withFooter('Summary', { model: null, extensions: [] }), null);
});

test('withFooter never touches an Extensions line the agent wrote, but still adds a missing Model', () => {
  const body = 'Summary\n\nExtensions: acme/other';
  assert.equal(withFooter(body, { extensions: ['acme/widgets-ext'] }), null);
  assert.equal(withFooter(body, { model: 'gpt-5.5', extensions: ['acme/widgets-ext'] }), `${body}\n\nModel: gpt-5.5`);
  assert.equal(withFooter('Summary\n\nModel: gpt-5.5', { model: 'gpt-5.5', extensions: ['acme/widgets-ext'] }), 'Summary\n\nModel: gpt-5.5\n\nExtensions: acme/widgets-ext');
});

test('tagPr is idempotent: a second run over its own output edits nothing', async () => {
  const first = fakeGh('Summary');
  assert.equal(await tagPr({ prUrl: PR, model: 'gpt-5.5', extensions: ['acme/widgets-ext'], gh: first.gh }), 'tagged');
  const second = fakeGh(first.calls[1].input);
  assert.equal(await tagPr({ prUrl: PR, model: 'gpt-5.5', extensions: ['acme/widgets-ext'], gh: second.gh }), 'present');
  assert.equal(second.calls.length, 1);
});

test('fetchFooterFacts returns the extensions, dropping anything that is not a name', async () => {
  const facts = await fetchFooterFacts({ url: 'u', session: 'CARD', fetchImpl: json({ model: 'm', extensions: ['acme/widgets-ext', 3, ''] }) });
  assert.deepEqual(facts, { model: 'm', extensions: ['acme/widgets-ext'] });
  assert.deepEqual(await fetchFooterFacts({ url: 'u', session: 'CARD', fetchImpl: json({ model: null }) }), { model: null, extensions: [] });
});

test('runModelFooter: model off but extensions on still tags the extensions', async () => {
  const { gh, calls } = fakeGh('Summary');
  const env = { AW_PR_MODEL_URL: 'u', AW_SESSION_ID: 'CARD' };
  assert.equal(await runModelFooter({ prUrl: PR, env, fetchImpl: json({ model: null, extensions: ['acme/widgets-ext'] }), gh }), 'tagged');
  assert.equal(calls[1].input, 'Summary\n\nExtensions: acme/widgets-ext');
});
