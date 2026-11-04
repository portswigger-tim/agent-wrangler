import { execFile } from 'node:child_process';

// The `gh` CLI the human is already signed in to, for the few GitHub reads and
// writes that need their identity. No token of the wrangler's own: `gh` holds
// the credential, and a human without it (or signed out) gets the
// unauthenticated path, or nothing.
//
// A LEAF: node:child_process only. Callers take the runner as a parameter or
// seam so tests stub `gh` without spawning anything.

const TIMEOUT_MS = 15000;

// `(args) => Promise<{ code, stdout, stderr }>`, resolving on a non-zero exit
// too: `gh api` exits 1 for a 404, and "not found" is an answer, not a
// failure. Only a `gh` that could not run at all rejects.
export function realGh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: TIMEOUT_MS, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') { reject(err); return; }
      resolve({ code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
