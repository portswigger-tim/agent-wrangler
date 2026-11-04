import { writeConfig } from '../../config-store.js';

export const prExtensionsFooterHandler = {
  type: 'set-pr-extensions-footer',
  async handler(msg, ctx) {
    writeConfig({ prExtensionsFooter: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
