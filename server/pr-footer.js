// The footer for PRs an agent creates: after a `gh pr create`, the session's
// live model id is appended to the PR body as `Model: <id>`, and the installed
// extensions it used as `Extensions: <owner/repo>, ...`, so PRs can be searched
// by either (`gh search prs '"Model: claude-opus-5-5" in:body'`,
// `gh search prs '"Extensions:" acme/widgets-ext in:body'`). Each line has its
// own setting and is added only when the body has no such line yet, ours or
// one the agent wrote itself. Below them, a collapsed per-extension usage table
// for the PR's window (usageBlock), with the same facts as a v1 JSON comment
// for tools to parse; it too has its own setting and is added once.
// Shared by every agent's post-tool hook (scripts/pr-model-footer.mjs is the
// Claude one). Dependency-free beyond node builtins: the devcontainer runtime
// copies this file into the container beside the hook scripts.
import { spawn } from 'node:child_process';

// A `Model:` line anywhere in the body, ours or one the agent wrote itself.
const MODEL_LINE = /^Model:[ \t]*\S/m;
// The same for `Extensions:`.
const EXTENSIONS_LINE = /^Extensions:[ \t]*\S/m;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function hasModelLine(body) {
  return MODEL_LINE.test(String(body ?? ''));
}

export function hasExtensionsLine(body) {
  return EXTENSIONS_LINE.test(String(body ?? ''));
}

// Our usage block, or anything that looks like one.
const USAGE_MARK = /agent-wrangler:usage|<summary>Extension usage/;
export function hasUsageBlock(body) {
  return USAGE_MARK.test(String(body ?? ''));
}

// Every name, uncapped (truncating would drop the attribution an owner searches
// for), sorted case-insensitively and de-duplicated the same way, as GitHub
// owner/repo names are: the line never depends on ledger or install order.
export function extensionNames(extensions) {
  const names = (Array.isArray(extensions) ? extensions : []).filter((x) => typeof x === 'string' && x);
  const seen = new Set();
  return names
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en') || (a < b ? -1 : a > b ? 1 : 0))
    .filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

// Tools listed per extension in the table; the JSON comment keeps them all.
const TABLE_TOOLS = 10;
const NONE = '—';

// Table-cell text: one line, with a pipe escaped so it can't split the cell and
// a backtick escaped so it can't open a code span. HTML is neutralised too: an
// extension, not us, chose these names.
const cellText = (s) => String(s).replace(/\s+/g, ' ')
  .replace(/[\\`|*_[\]]/g, (c) => `\\${c}`)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A name as a code span, or as escaped text when it holds a backtick (which no
// code span can). A pipe inside a code span still needs its backslash: GitHub
// splits table cells before it reads code spans.
const cellCode = (s) => (/[`\s]/.test(String(s)) || !String(s) ? cellText(s) : `\`${String(s).replace(/\|/g, '\\|')}\``);

// The usage facts restricted to the names the Extensions line lists, in its
// order, each in the v1 shape.
function usageRows(usage) {
  const given = isObj(usage?.extensions) ? usage.extensions : {};
  return extensionNames(Object.keys(given)).map((name) => {
    const u = isObj(given[name]) ? given[name] : {};
    const tools = Object.fromEntries(Object.entries(isObj(u.tools) ? u.tools : {})
      .filter(([t, n]) => t && Number.isInteger(n) && n > 0)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
    const skills = [...new Set((Array.isArray(u.skills) ? u.skills : []).filter((x) => typeof x === 'string' && x))].sort();
    const commit = typeof u.commit === 'string' && /^[0-9a-f]{4,40}$/i.test(u.commit) ? u.commit.slice(0, 7) : null;
    return [name, { commit, tools, skills, runtime: u.runtime === true }];
  });
}

// The collapsed usage table plus its machine-readable comment, or null when no
// extension qualifies. `usage` is `{ window, extensions: { [owner/repo]: {
// commit, tools: { name: calls }, skills: [name], runtime } } }`.
export function usageBlock(usage) {
  const rows = usageRows(usage);
  if (!rows.length) return null;
  const table = rows.map(([name, u]) => {
    const tools = Object.entries(u.tools);
    const shown = tools.slice(0, TABLE_TOOLS).map(([t, n]) => `${cellCode(t)} (${n})`);
    if (tools.length > TABLE_TOOLS) shown.push(`+${tools.length - TABLE_TOOLS} more`);
    return `| ${cellText(name)} | ${u.commit ? cellCode(u.commit) : NONE} | ${shown.join(', ') || NONE} | ${u.skills.map(cellCode).join(', ') || NONE} | ${u.runtime ? 'yes' : NONE} |`;
  });
  const json = { window: usage.window === 'previous-pr' ? 'previous-pr' : 'session-start', extensions: Object.fromEntries(rows) };
  // `--` would end the HTML comment early; `\u002d` is the same hyphen to a
  // JSON parser. Only a string can hold two hyphens in a row.
  const data = JSON.stringify(json).replace(/--/g, '-\\u002d');
  return [
    '<details>',
    '<summary>Extension usage in this PR</summary>',
    '',
    '| Extension | Commit | Tools (calls) | Skills | Runtime |',
    '| --- | --- | --- | --- | --- |',
    ...table,
    '',
    `<!-- agent-wrangler:usage v1 ${data} -->`,
    '</details>',
  ].join('\n');
}

// What this body still needs, in order: the Model and Extensions lines as one
// chunk, then the usage block.
function footerChunks(body, { model, extensions, usage } = {}) {
  const lines = [];
  if (model && !hasModelLine(body)) lines.push(`Model: ${model}`);
  const names = extensionNames(extensions);
  if (names.length && !hasExtensionsLine(body)) lines.push(`Extensions: ${names.join(', ')}`);
  const chunks = lines.length ? [lines.join('\n')] : [];
  const block = usage && !hasUsageBlock(body) ? usageBlock(usage) : null;
  if (block) chunks.push(block);
  return chunks;
}

// The body with the footer appended after one blank line, or null when it
// needs none.
export function withFooter(body, facts) {
  const chunks = footerChunks(body, facts);
  if (!chunks.length) return null;
  const text = String(body ?? '').replace(/\s+$/, '');
  return [text, ...chunks].filter(Boolean).join('\n\n');
}

// Asks the wrangler what to tag PR `prUrl` with: `{ model, extensions, usage }`.
// `model` is null, `extensions` empty and `usage` null when their setting is
// off, the session is unknown or the server is unreachable. The PR url lets the
// wrangler start the session's next usage window here, and answer a rerun for
// the same PR with the same window.
export async function fetchFooterFacts({ url, session, prUrl, fetchImpl = fetch }) {
  const none = { model: null, extensions: [], usage: null };
  if (!url || !session) return none;
  const headers = { 'X-AW-Session': session, ...(prUrl ? { 'X-AW-PR': prUrl } : {}) };
  const res = await fetchImpl(url, { method: 'POST', headers });
  if (!res.ok) return none;
  const data = await res.json();
  const model = typeof data?.model === 'string' && data.model ? data.model : null;
  const extensions = Array.isArray(data?.extensions) ? data.extensions.filter((x) => typeof x === 'string' && x) : [];
  const usage = isObj(data?.usage) ? data.usage : null;
  return { model, extensions, usage };
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

// Reads the PR body and appends whichever footer parts it lacks. Returns
// 'tagged', 'present' (every part it would add is already there) or 'skipped'
// (nothing to add at all).
export async function tagPr({ prUrl, model, extensions, usage, gh = runGh }) {
  if (!prUrl || !footerChunks('', { model, extensions, usage }).length) return 'skipped';
  const body = (await gh(['pr', 'view', prUrl, '--json', 'body', '--jq', '.body'])).replace(/\n$/, '');
  const next = withFooter(body, { model, extensions, usage });
  if (next == null) return 'present';
  await gh(['pr', 'edit', prUrl, '--body-file', '-'], next);
  return 'tagged';
}

// The whole footer step for a PR just created: facts from the wrangler, then
// one body edit. Env carries the session (AW_SESSION_ID) and the lookup url
// (AW_PR_MODEL_URL), both set at launch.
export async function runModelFooter({ prUrl, env = process.env, fetchImpl = fetch, gh = runGh }) {
  const facts = await fetchFooterFacts({ url: env.AW_PR_MODEL_URL, session: env.AW_SESSION_ID, prUrl, fetchImpl });
  return tagPr({ prUrl, ...facts, gh });
}
