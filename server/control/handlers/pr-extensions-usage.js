import { writeConfig } from '../../config-store.js';

export const prExtensionsUsageHandler = {
  type: 'set-pr-extensions-usage',
  async handler(msg, ctx) {
    writeConfig({ prExtensionsUsage: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
