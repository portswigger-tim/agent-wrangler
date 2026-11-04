import path from 'node:path';
import { DATA_DIR } from './data-dir.js';
import { writeJsonAtomic, readJsonOrLoud } from './atomic-json.js';

// The local per-extension usage ledger: which installed extensions each session
// actually USED, and per extension how often. It feeds two things only — the
// Settings › Extensions detail pane and the `Extensions:` PR footer
// (server/pr-footer.js) — and never leaves this machine: there is no telemetry
// endpoint, and no extension can read it (it is deliberately absent from the
// host API).
//
// Only GIT-INSTALLED extensions are recorded: ones with a provenance record
// carrying an origin (server/extensions/provenance.js). A builtin, or a
// directory dropped into <data dir>/extensions by hand, is refused here by the
// `isTracked` predicate, so it never reaches the file at all — not merely
// filtered at display time. The footer names an extension by its GitHub
// `owner/repo`, and only an origin can give it one.
//
// Sources, each fed from the seam that already sees it (server/index.js wires
// them): an extension's MCP tool call, a launch on a runtime it contributes, a
// board control handler it owns, a dispatch carrying its `ext.<id>` fields, and
// a skill it ships or gates, read off the session's transcript.
//
// Shape on disk:
//   { extensions: { [extId]: { sessions, tools, skills, runtimes, handlers, fields, lastUsedAt } },
//     sessions:   { [sessionId]: { extIds: [...], seen: { [transcript]: { [skill]: n } }, at } } }
// `seen` holds the ABSOLUTE skill counts last read from each transcript, so a
// rescan after a restart (which starts from byte 0) adds nothing twice.

const usageFile = () => path.join(DATA_DIR, 'extension-usage.json');

// Oldest sessions are dropped past this. A dropped session that is still on the
// board would re-count its skills on the next tick, so it sits well above any
// board's card count.
const MAX_SESSIONS = 2000;
const KINDS = ['tools', 'skills', 'runtimes', 'handlers', 'fields'];

// A skill name as it appears in a Claude Skill tool call: bare (`links`),
// prefixed with the in-repo plugin (`agent-skills:links`), or prefixed with the
// one-skill plugin an extension-shipped skill loads as (`widgets:widgets`).
// Returns the owning extension id, or null for a skill no extension declares or
// one some unrelated plugin happens to ship under the same bare name.
export function skillOwnerIn(list, name) {
  if (typeof name !== 'string' || !name) return null;
  const colon = name.lastIndexOf(':');
  const prefix = colon >= 0 ? name.slice(0, colon) : null;
  const bare = colon >= 0 ? name.slice(colon + 1) : name;
  const owner = (list || []).find((e) => (e.skills || []).includes(bare));
  if (!owner) return null;
  if (prefix != null && prefix !== bare && prefix !== 'agent-skills' && prefix !== owner.id) return null;
  return owner.id;
}

export const bareSkillName = (name) => String(name).slice(String(name).lastIndexOf(':') + 1);

// Skill names read through a `<...>/skills/<name>/SKILL.md` path in a command
// line — how a Codex session loads a skill (it reads the file its catalog
// points at; there is no Skill tool call to see). Best effort: a SKILL.md read
// for any other reason counts too.
const SKILL_READ_RE = /\/skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/gi;
export function skillReadsIn(text) {
  if (typeof text !== 'string' || !text.includes('SKILL.md')) return [];
  return [...new Set([...text.matchAll(SKILL_READ_RE)].map((m) => m[1]))];
}

const blankExt = () => ({ sessions: 0, tools: {}, skills: {}, runtimes: {}, handlers: {}, fields: {}, lastUsedAt: null });
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const counts = (v) => Object.fromEntries(Object.entries(isObj(v) ? v : {}).filter(([, n]) => Number.isFinite(n) && n > 0));

export class ExtensionUsageStore {
  // `isTracked(extId)` gates every write (git-installed only, see above);
  // `skillOwner(name)` maps a Skill tool name to an extension id. Both read the
  // live registry per call, so an install or uninstall needs no invalidation.
  constructor({ file = usageFile(), isTracked = () => false, skillOwner = () => null, now = Date.now, saveDelayMs = 1000 } = {}) {
    this.file = file;
    this.isTracked = isTracked;
    this.skillOwner = skillOwner;
    this.now = now;
    this.saveDelayMs = saveDelayMs;
    this.timer = null;
    this.dirty = false;
    this._load();
  }

  _load() {
    const raw = readJsonOrLoud(this.file, 'extension-usage.json');
    this.extensions = {};
    this.sessions = {};
    for (const [id, e] of Object.entries(isObj(raw?.extensions) ? raw.extensions : {})) {
      if (!isObj(e)) continue;
      this.extensions[id] = {
        sessions: Number.isFinite(e.sessions) ? e.sessions : 0,
        ...Object.fromEntries(KINDS.map((k) => [k, counts(e[k])])),
        lastUsedAt: typeof e.lastUsedAt === 'string' ? e.lastUsedAt : null,
      };
    }
    for (const [sid, s] of Object.entries(isObj(raw?.sessions) ? raw.sessions : {})) {
      if (!isObj(s)) continue;
      this.sessions[sid] = {
        extIds: Array.isArray(s.extIds) ? s.extIds.filter((x) => typeof x === 'string') : [],
        seen: Object.fromEntries(Object.entries(isObj(s.seen) ? s.seen : {}).map(([k, v]) => [k, counts(v)])),
        at: Number.isFinite(s.at) ? s.at : 0,
      };
    }
  }

  _session(sessionId) {
    const s = (this.sessions[sessionId] ||= { extIds: [], seen: {}, at: 0 });
    s.at = this.now();
    return s;
  }

  // One use of `name` (a tool, skill, runtime, handler type or dispatch field
  // set) of `kind` by `extId`, from `sessionId` when there is one — a board
  // control frame has no session. A no-op for an untracked extension.
  note(sessionId, extId, kind, name, n = 1) {
    if (!KINDS.includes(kind) || !extId || !name || !(n > 0) || !this.isTracked(extId)) return false;
    const e = (this.extensions[extId] ||= blankExt());
    e[kind][name] = (e[kind][name] || 0) + n;
    e.lastUsedAt = new Date(this.now()).toISOString();
    if (sessionId) {
      const s = this._session(sessionId);
      if (!s.extIds.includes(extId)) {
        s.extIds.push(extId);
        e.sessions += 1;
      }
    }
    this._scheduleSave();
    return true;
  }

  // The skill counts read from one of the session's transcripts, as absolute
  // totals (`{ name: n }`). Only the growth since the last read is counted, so
  // the graph tick can hand the same totals over every few seconds.
  noteSkillTotals(sessionId, transcript, totals) {
    if (!sessionId || !isObj(totals)) return;
    const key = transcript || sessionId;
    let s = this.sessions[sessionId];
    const prev = s?.seen?.[key] || {};
    let grew = false;
    for (const [name, total] of Object.entries(totals)) {
      if (!Number.isFinite(total) || total <= (prev[name] || 0)) continue;
      // Only a tracked extension's skills are remembered at all, baseline
      // included — a builtin's or another plugin's never reach the file.
      const extId = this.skillOwner(name);
      if (!extId || !this.isTracked(extId)) continue;
      const delta = total - (prev[name] || 0);
      s ||= this._session(sessionId);
      (s.seen[key] ||= {})[name] = total;
      grew = true;
      this.note(sessionId, extId, 'skills', bareSkillName(name), delta);
    }
    if (grew) this._scheduleSave();
  }

  // The tracked extensions this session used, sorted for a stable footer. The
  // tracked check runs again here: an extension uninstalled (or reinstalled by
  // hand, losing its origin) since the use is no longer one to name.
  extensionsFor(sessionId) {
    return [...(this.sessions[sessionId]?.extIds || [])].filter((id) => this.isTracked(id)).sort();
  }

  // What the detail pane shows for one extension, or null when it has never
  // been used (or is untracked). `top` caps each per-name list.
  summary(extId, { top = 5 } = {}) {
    const e = this.extensions[extId];
    if (!e || !this.isTracked(extId)) return null;
    const ranked = (m) => Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top).map(([name, count]) => ({ name, count }));
    return {
      sessions: e.sessions,
      lastUsedAt: e.lastUsedAt,
      ...Object.fromEntries(KINDS.map((k) => [k, ranked(e[k])])),
    };
  }

  _scheduleSave() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.saveDelayMs);
    this.timer.unref?.();
  }

  // Writes only what changed since the last write, so it is safe to call on
  // every exit.
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    const ids = Object.keys(this.sessions);
    if (ids.length > MAX_SESSIONS) {
      ids.sort((a, b) => this.sessions[a].at - this.sessions[b].at);
      for (const id of ids.slice(0, ids.length - MAX_SESSIONS)) delete this.sessions[id];
    }
    writeJsonAtomic(this.file, { extensions: this.extensions, sessions: this.sessions }, { trailingNewline: true });
  }
}
