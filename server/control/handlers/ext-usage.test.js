import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extUsageHandler } from './ext-usage.js';

function run(msg, extUsage) {
  const replies = [];
  return extUsageHandler.handler(msg, { extUsage, reply: (r) => replies.push(r) }).then(() => replies);
}

test('replies with the summary for the asked-for extension', async () => {
  const extUsage = { summary: (id) => (id === 'widgets' ? { sessions: 3 } : null) };
  assert.deepEqual(await run({ type: 'ext-usage', id: 'widgets' }, extUsage), [{ type: 'ext-usage', id: 'widgets', usage: { sessions: 3 } }]);
  assert.deepEqual(await run({ type: 'ext-usage', id: 'checklist' }, extUsage), [{ type: 'ext-usage', id: 'checklist', usage: null }]);
});

test('a malformed id answers null rather than throwing', async () => {
  assert.deepEqual(await run({ type: 'ext-usage', id: 7 }, { summary: () => ({}) }), [{ type: 'ext-usage', id: '', usage: null }]);
});
