// The footer for PRs an agent creates: after a `gh pr create`, the session's
// live model id is appended to the PR body as `Model: <id>`, and the installed
// extensions it used as `Extensions: <owner/repo>, ...`, so PRs can be searched
// by either (`gh search prs '"Model: claude-opus-5-5" in:body'`,
// `gh search prs '"Extensions:" acme/widgets-ext in:body'`). Each line has its
// own setting and is added only when the body has no such line yet, ours or
// one the agent wrote itself.
// Shared by every agent's post-tool hook (scripts/pr-model-footer.mjs is the
// Claude one). Dependency-free beyond node builtins: the devcontainer runtime
// copies this file into the container beside the hook scripts.
import { spawn } from 'node:child_process';

// A `Model:` line anywhere in the body, ours or one the agent wrote itself.
const MODEL_LINE = /^Model:[ \t]*\S/m;
// The same for `Extensions:`.
const EXTENSIONS_LINE = /^Extensions:[ \t]*\S/m;

export function hasModelLine(body) {
  return MODEL_LINE.test(String(body ?? ''));
}

export function hasExtensionsLine(body) {
  return EXTENSIONS_LINE.test(String(body ?? ''));
}

// The footer lines this body still needs, in order: Model then Extensions.
function footerLines(body, { model, extensions } = {}) {
  const lines = [];
  if (model && !hasModelLine(body)) lines.push(`Model: ${model}`);
  const names = (Array.isArray(extensions) ? extensions : []).filter((x) => typeof x === 'string' && x);
  if (names.length && !hasExtensionsLine(body)) lines.push(`Extensions: ${names.join(', ')}`);
  return lines;
}

// The body with the footer appended after one blank line, or null when it
// needs none.
export function withFooter(body, facts) {
  const lines = footerLines(body, facts);
  if (!lines.length) return null;
  const text = String(body ?? '').replace(/\s+$/, '');
  return text ? `${text}\n\n${lines.join('\n')}` : lines.join('\n');
}

// Asks the wrangler what to tag this session's PRs with: `{ model, extensions }`.
// `model` is null and `extensions` empty when their setting is off, the session
// is unknown or the server is unreachable.
export async function fetchFooterFacts({ url, session, fetchImpl = fetch }) {
  const none = { model: null, extensions: [] };
  if (!url || !session) return none;
  const res = await fetchImpl(url, { method: 'POST', headers: { 'X-AW-Session': session } });
  if (!res.ok) return none;
  const data = await res.json();
  const model = typeof data?.model === 'string' && data.model ? data.model : null;
  const extensions = Array.isArray(data?.extensions) ? data.extensions.filter((x) => typeof x === 'string' && x) : [];
  return { model, extensions };
}

// `gh <args>` with optional stdin, resolving to its stdout; rejects on a
// non-zero exit.
export function runGh(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`gh exited ${code}`))));
    child.stdin.end(input ?? '');
  });
}

// Reads the PR body and appends whichever footer lines it lacks. Returns
// 'tagged', 'present' (every line it would add is already there) or 'skipped'
// (nothing to add at all).
export async function tagPr({ prUrl, model, extensions, gh = runGh }) {
  if (!prUrl || !footerLines('', { model, extensions }).length) return 'skipped';
  const body = (await gh(['pr', 'view', prUrl, '--json', 'body', '--jq', '.body'])).replace(/\n$/, '');
  const next = withFooter(body, { model, extensions });
  if (next == null) return 'present';
  await gh(['pr', 'edit', prUrl, '--body-file', '-'], next);
  return 'tagged';
}

// The whole footer step for a PR just created: facts from the wrangler, then
// one body edit. Env carries the session (AW_SESSION_ID) and the lookup url
// (AW_PR_MODEL_URL), both set at launch.
export async function runModelFooter({ prUrl, env = process.env, fetchImpl = fetch, gh = runGh }) {
  const facts = await fetchFooterFacts({ url: env.AW_PR_MODEL_URL, session: env.AW_SESSION_ID, fetchImpl });
  return tagPr({ prUrl, ...facts, gh });
}
