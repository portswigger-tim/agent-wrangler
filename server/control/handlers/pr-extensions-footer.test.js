import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prExtensionsFooterHandler } from './pr-extensions-footer.js';
import { prExtensionsFooterEnabled, readConfig } from '../../config-store.js';

test('set-pr-extensions-footer writes the switch and rebuilds', async () => {
  let rebuilt = 0;
  const ctx = { rebuild: async () => { rebuilt += 1; } };
  await prExtensionsFooterHandler.handler({ type: 'set-pr-extensions-footer', enabled: false }, ctx);
  assert.equal(prExtensionsFooterEnabled(readConfig()), false);
  await prExtensionsFooterHandler.handler({ type: 'set-pr-extensions-footer', enabled: true }, ctx);
  assert.equal(prExtensionsFooterEnabled(readConfig()), true);
  assert.equal(rebuilt, 2);
});
