import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasModelLine, hasExtensionsLine, hasUsageBlock, usageBlock, extensionNames, withFooter, fetchFooterFacts, tagPr, runModelFooter } from './pr-footer.js';

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
    'Summary\n\nModel: claude-opus-5-5\nExtensions: acme/gadgets-ext, acme/widgets-ext',
  );
  assert.equal(withFooter('Summary', { extensions: ['acme/widgets-ext'] }), 'Summary\n\nExtensions: acme/widgets-ext');
  assert.equal(withFooter('Summary', { model: null, extensions: [] }), null);
});

test('the Extensions line names every extension, uncapped, sorted and de-duplicated case-insensitively', () => {
  const repos = Array.from({ length: 15 }, (_, i) => `acme/ext-${String.fromCharCode(111 - i)}`);
  const given = [...repos, 'Zeta/Tools', 'acme/EXT-o', 'acme/ext-a', 'beta/kit', 'acme/ext-c', 'zeta/tools'];
  const names = extensionNames(given);
  assert.equal(names.length, 17);
  assert.deepEqual(names, [
    ...repos.slice().sort().map((n) => (n === 'acme/ext-o' ? 'acme/EXT-o' : n)), 'beta/kit', 'Zeta/Tools',
  ]); // case-only duplicates keep the spelling that sorts first by code point
  assert.deepEqual(extensionNames([...given].reverse()).map((n) => n.toLowerCase()), names.map((n) => n.toLowerCase()));
  assert.equal(withFooter('Summary', { extensions: given }), `Summary\n\nExtensions: ${names.join(', ')}`);
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
  assert.deepEqual(facts, { model: 'm', extensions: ['acme/widgets-ext'], usage: null });
  assert.deepEqual(await fetchFooterFacts({ url: 'u', session: 'CARD', fetchImpl: json({ model: null }) }), { model: null, extensions: [], usage: null });
});

test('runModelFooter: model off but extensions on still tags the extensions', async () => {
  const { gh, calls } = fakeGh('Summary');
  const env = { AW_PR_MODEL_URL: 'u', AW_SESSION_ID: 'CARD' };
  assert.equal(await runModelFooter({ prUrl: PR, env, fetchImpl: json({ model: null, extensions: ['acme/widgets-ext'] }), gh }), 'tagged');
  assert.equal(calls[1].input, 'Summary\n\nExtensions: acme/widgets-ext');
});

// The usage block's JSON comment, parsed back as a reader would.
const usageJson = (body) => JSON.parse(body.match(/<!-- agent-wrangler:usage v1 (.*) -->/)[1]);
const WIDGETS = { commit: '0123456789abcdef', tools: { widget_list: 3, widget_make: 12 }, skills: ['widgets'], runtime: false };

test('usageBlock renders a collapsed table and a v1 JSON comment holding the same facts', () => {
  const block = usageBlock({ window: 'session-start', extensions: { 'acme/widgets-ext': WIDGETS, 'acme/gadgets-ext': { runtime: true } } });
  assert.equal(block, [
    '<details>',
    '<summary>Extension usage in this PR</summary>',
    '',
    '| Extension | Commit | Tools (calls) | Skills | Runtime |',
    '| --- | --- | --- | --- | --- |',
    '| acme/gadgets-ext | — | — | — | yes |',
    '| acme/widgets-ext | `0123456` | `widget_make` (12), `widget_list` (3) | `widgets` | — |',
    '',
    '<!-- agent-wrangler:usage v1 {"window":"session-start","extensions":{"acme/gadgets-ext":{"commit":null,"tools":{},"skills":[],"runtime":true},"acme/widgets-ext":{"commit":"0123456","tools":{"widget_make":12,"widget_list":3},"skills":["widgets"],"runtime":false}}} -->',
    '</details>',
  ].join('\n'));
  assert.equal(usageBlock({ window: 'previous-pr', extensions: {} }), null);
  assert.equal(usageBlock(null), null);
  assert.equal(usageJson(usageBlock({ window: 'previous-pr', extensions: { 'acme/widgets-ext': WIDGETS } })).window, 'previous-pr');
});

test('usageBlock lists the top 10 tools with "+N more"; the JSON keeps every one', () => {
  const tools = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`tool_${String(i).padStart(2, '0')}`, 20 - i]));
  const block = usageBlock({ window: 'session-start', extensions: { 'acme/widgets-ext': { tools } } });
  const row = block.split('\n').find((l) => l.startsWith('| acme/widgets-ext'));
  assert.match(row, /`tool_09` \(11\), \+3 more \|/);
  assert.doesNotMatch(row, /tool_10/);
  assert.deepEqual(usageJson(block).extensions['acme/widgets-ext'].tools, tools);
});

test('usageBlock escapes pipes and backticks in cells and "--" in the comment', () => {
  const tools = { 'a|b': 2, 'x`y': 1, 'p--q': 1, 'end-->': 1 };
  const block = usageBlock({ window: 'session-start', extensions: { 'acme/widgets-ext': { tools, skills: ['s|k'] } } });
  const row = block.split('\n').find((l) => l.startsWith('| acme/widgets-ext'));
  // Exactly the six real cell separators: no name's pipe splits a cell.
  assert.equal(row.replace(/\\\|/g, '').split('|').length - 1, 6);
  assert.match(row, /`a\\\|b` \(2\)/);
  assert.match(row, /x\\`y \(1\)/);
  assert.match(row, /`s\\\|k`/);
  const comment = block.match(/<!--(.*)-->/)[1];
  assert.doesNotMatch(comment, /--/);
  assert.deepEqual(usageJson(block).extensions['acme/widgets-ext'].tools, { 'a|b': 2, 'end-->': 1, 'p--q': 1, 'x`y': 1 });
});

test('withFooter puts the usage block after the lines, once, and leaves any existing one alone', () => {
  const usage = { window: 'session-start', extensions: { 'acme/widgets-ext': WIDGETS } };
  const facts = { model: 'gpt-5.5', extensions: ['acme/widgets-ext'], usage };
  const once = withFooter('Summary', facts);
  assert.ok(once.startsWith('Summary\n\nModel: gpt-5.5\nExtensions: acme/widgets-ext\n\n<details>\n'));
  assert.equal(hasUsageBlock(once), true);
  assert.equal(withFooter(once, facts), null);
  // Lines already there (ours or the agent's): only the block is added.
  assert.equal(withFooter('Summary\n\nModel: x\nExtensions: acme/other', facts), `Summary\n\nModel: x\nExtensions: acme/other\n\n${usageBlock(usage)}`);
  // A hand-written block, or one with only our summary line, stops ours.
  assert.equal(withFooter('Summary\n\n<details><summary>Extension usage</summary></details>', { usage }), null);
  assert.equal(withFooter('<!-- agent-wrangler:usage v0 {} -->', { usage }), null);
  // Its own switch: no usage facts, no block, lines unchanged.
  assert.equal(withFooter('Summary', { ...facts, usage: null }), 'Summary\n\nModel: gpt-5.5\nExtensions: acme/widgets-ext');
});

test('runModelFooter sends the PR url and tags the usage block from the answer', async () => {
  let headers;
  const usage = { window: 'session-start', extensions: { 'acme/widgets-ext': WIDGETS } };
  const fetchImpl = async (_url, opts) => { headers = opts.headers; return { ok: true, json: async () => ({ model: null, extensions: ['acme/widgets-ext'], usage }) }; };
  const first = fakeGh('Summary');
  const env = { AW_PR_MODEL_URL: 'u', AW_SESSION_ID: 'CARD' };
  assert.equal(await runModelFooter({ prUrl: PR, env, fetchImpl, gh: first.gh }), 'tagged');
  assert.equal(headers['X-AW-PR'], PR);
  assert.equal(first.calls[1].input, `Summary\n\nExtensions: acme/widgets-ext\n\n${usageBlock(usage)}`);
  const second = fakeGh(first.calls[1].input);
  assert.equal(await runModelFooter({ prUrl: PR, env, fetchImpl, gh: second.gh }), 'present');
});
