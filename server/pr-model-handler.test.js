import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrModelHandler } from './pr-model-handler.js';
import { claudeModelId } from './agents/claude.js';

function call(handler, headers = {}) {
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      status: 0,
      writeHead(status) { this.status = status; this.headersSent = true; return this; },
      end(body) { resolve({ status: this.status, body }); },
    };
    handler({ headers }, res);
  });
}

const graph = {
  sessions: [
    { sessionId: 'LIVE', agent: 'claude', currentModel: 'claude-sonnet-5-5', model: 'opus' },
    { sessionId: 'FRESH', agent: 'claude', currentModel: null, model: 'opus' },
    { sessionId: 'CODEX', agent: 'codex', currentModel: null, model: 'gpt-5.5' },
  ],
};
const entries = { ARCHIVED: { agent: 'claude', model: 'haiku' } };
const handler = (enabled = true) => createPrModelHandler({ graph: () => graph, entryFor: (id) => entries[id] || null, enabled: () => enabled });
const model = async (h, session) => JSON.parse((await call(h, { 'x-aw-session': session })).body).model;

test('answers the live transcript model over the launch model', async () => {
  assert.equal(await model(handler(), 'LIVE'), 'claude-sonnet-5-5');
});

test('falls back to the launch model as an exact id', async () => {
  assert.equal(await model(handler(), 'FRESH'), claudeModelId('opus'));
  assert.match(await model(handler(), 'FRESH'), /^claude-opus-/);
  assert.equal(await model(handler(), 'CODEX'), 'gpt-5.5');
  assert.match(await model(handler(), 'ARCHIVED'), /^claude-haiku-/);
});

test('null with the setting off, or for an unknown card', async () => {
  assert.equal(await model(handler(false), 'LIVE'), null);
  assert.equal(await model(handler(), 'NOPE'), null);
});

test('400 without a caller', async () => {
  assert.equal((await call(handler())).status, 400);
});

const extHandler = ({ on = true, refreshUsage, usageOn = false, usageFor } = {}) => createPrModelHandler({
  graph: () => graph,
  entryFor: (id) => entries[id] || null,
  enabled: () => false,
  extensionsEnabled: () => on,
  extensionsFor: (id) => (id === 'LIVE' ? ['acme/widgets-ext'] : []),
  refreshUsage,
  usageEnabled: () => usageOn,
  usageFor,
});
const body = async (h, session) => JSON.parse((await call(h, { 'x-aw-session': session })).body);

test('answers the extensions the session used, under their own setting', async () => {
  assert.deepEqual(await body(extHandler(), 'LIVE'), { model: null, extensions: ['acme/widgets-ext'], usage: null });
  assert.deepEqual((await body(extHandler({ on: false }), 'LIVE')).extensions, []);
  assert.deepEqual((await body(extHandler(), 'NOPE')).extensions, []);
});

test('brings skill counts up to date before reading them, and survives a failed refresh', async () => {
  const seen = [];
  await body(extHandler({ refreshUsage: async (id) => { seen.push(id); } }), 'LIVE');
  assert.deepEqual(seen, ['LIVE']);
  const res = await body(extHandler({ refreshUsage: async () => { throw new Error('boom'); } }), 'LIVE');
  assert.deepEqual(res.extensions, ['acme/widgets-ext']);
});

test('answers the usage table for the PR in X-AW-PR, only under both settings and only with extensions', async () => {
  const asked = [];
  const usageFor = (id, pr) => { asked.push([id, pr]); return { window: 'session-start', extensions: {} }; };
  const pr = 'https://github.com/acme/app/pull/1';
  const res = await call(extHandler({ usageOn: true, usageFor }), { 'x-aw-session': 'LIVE', 'x-aw-pr': pr });
  assert.deepEqual(JSON.parse(res.body).usage, { window: 'session-start', extensions: {} });
  assert.deepEqual(asked, [['LIVE', pr]]);
  // Sub-switch off, Extensions line off, or nothing used: no window is taken.
  assert.equal((await body(extHandler({ usageOn: false, usageFor }), 'LIVE')).usage, null);
  assert.equal((await body(extHandler({ on: false, usageOn: true, usageFor }), 'LIVE')).usage, null);
  assert.equal((await body(extHandler({ usageOn: true, usageFor }), 'FRESH')).usage, null);
  assert.equal(asked.length, 1);
});
