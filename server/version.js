import fs from 'node:fs';
import os from 'node:os';

// The running app's version, from its own package.json — the single source the
// release process bumps, so `--version`, the startup banner and the formula's
// `brew test` all agree with the tag they were built from.
export const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

// The machine the wrangler runs on, as an issue report names it — the server's
// OS, which is where an extension runs, not the browser's.
export const platformText = () => `${os.type()} ${os.release()} (${process.arch})`;
