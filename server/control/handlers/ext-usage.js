// The Settings › Extensions detail pane's usage line: one extension's summary
// from the local usage ledger (server/extension-usage.js), asked for when the
// pane opens. Request/reply over the control WS like `usage`, rather than on
// every graph tick: the graph's extension list is what client extensions
// read, and the ledger is deliberately not theirs to see. `usage` is null for
// an extension with no recorded use, and for any that is not git-installed.
export const extUsageHandler = {
  type: 'ext-usage',
  async handler(msg, ctx) {
    const id = typeof msg.id === 'string' ? msg.id : '';
    ctx.reply({ type: 'ext-usage', id, usage: id ? ctx.extUsage?.summary(id) ?? null : null });
  },
};
