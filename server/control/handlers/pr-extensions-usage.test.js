import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prExtensionsUsageHandler } from './pr-extensions-usage.js';
import { prExtensionsUsageEnabled, readConfig, writeConfig } from '../../config-store.js';

test('set-pr-extensions-usage writes the sub-switch and rebuilds', async () => {
  let rebuilt = 0;
  const ctx = { rebuild: async () => { rebuilt += 1; } };
  writeConfig({ prExtensionsFooter: true });
  await prExtensionsUsageHandler.handler({ type: 'set-pr-extensions-usage', enabled: false }, ctx);
  assert.equal(prExtensionsUsageEnabled(readConfig()), false);
  await prExtensionsUsageHandler.handler({ type: 'set-pr-extensions-usage', enabled: true }, ctx);
  assert.equal(prExtensionsUsageEnabled(readConfig()), true);
  assert.equal(rebuilt, 2);
});
