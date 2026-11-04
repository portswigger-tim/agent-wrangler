import { realGh } from './gh-cli.js';

// Starring an extension's GitHub repository as the human, through the `gh` CLI
// they are already signed in to. OPT-IN ONLY: the install consent dialog offers
// it unticked, and nothing here runs unless the human ticked it. A star is a
// public action under their GitHub identity, so the wrangler never stars on its
// own, and it only ever unstars a star it added itself (the provenance record's
// `starredByWrangler`) — never one the human made.
//
// No token of the wrangler's own: `gh` holds the credential, and a human
// without `gh` signed in to github.com is simply never offered the checkbox.
//
// A LEAF: the `gh` runner (gh-cli.js) only. The runner is a parameter so tests
// stub `gh` without spawning anything.

const path = ({ owner, repo }) => `user/starred/${owner}/${repo}`;

// The signed-in github.com login, or null when `gh` is missing or signed out.
// `gh auth status` prints "Logged in to github.com account <login>" (older
// versions: "as <login>"), on stdout or stderr depending on the version.
export async function ghLogin(gh = realGh) {
  try {
    const r = await gh(['auth', 'status', '--hostname', 'github.com']);
    if (r.code !== 0) return null;
    const m = `${r.stdout}\n${r.stderr}`.match(/Logged in to github\.com (?:account|as) ([\w-]+)/);
    return m ? m[1] : '';
  } catch {
    return null;
  }
}

function failure(r) {
  const text = (r.stderr || r.stdout).trim().split('\n')[0];
  return new Error(text || `gh exited ${r.code}`);
}

// GET /user/starred/<owner>/<repo> answers 204 when starred and 404 when not;
// `--include` puts the status line on stdout either way.
export async function isStarred(repo, gh = realGh) {
  const r = await gh(['api', '--hostname', 'github.com', '--include', path(repo)]);
  const status = Number(r.stdout.match(/^HTTP\/[\d.]+ (\d{3})/)?.[1]);
  if (status === 204) return true;
  if (status === 404) return false;
  throw failure(r);
}

async function send(method, repo, gh) {
  const r = await gh(['api', '--hostname', 'github.com', '--method', method, '--silent', path(repo)]);
  if (r.code !== 0) throw failure(r);
}

// Stars it unless the human already had. `{ starred: true }` means the wrangler
// added the star and should record `starredByWrangler`; `{ starred: false }`
// means it was already starred, so there is nothing of ours to undo later.
export async function starRepo(repo, gh = realGh) {
  if (await isStarred(repo, gh)) return { starred: false };
  await send('PUT', repo, gh);
  return { starred: true };
}

export const unstarRepo = (repo, gh = realGh) => send('DELETE', repo, gh);
