import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExtensionUsageStore, skillOwnerIn, skillReadsIn, bareSkillName } from './extension-usage.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ext-usage-')), 'extension-usage.json');

// The registry as the ledger sees it: one git-installed extension, one builtin
// and one dropped in by hand with no provenance.
const LIST = [
  { id: 'widgets', external: true, provenance: { originUrl: 'https://github.com/acme/widgets-ext' }, skills: ['widgets', 'shared-skill'] },
  { id: 'checklist', external: false, provenance: null, skills: ['checklist'] },
  { id: 'handmade', external: true, provenance: null, skills: ['handmade'] },
];
const tracked = (id) => Boolean(LIST.find((e) => e.id === id && e.external && e.provenance?.originUrl));

function store(opts = {}) {
  return new ExtensionUsageStore({ file: tmpFile(), isTracked: tracked, skillOwner: (n) => skillOwnerIn(LIST, n), now: () => 1_700_000_000_000, ...opts });
}

test('counts tool calls per tool and the sessions an extension is used in', () => {
  const s = store();
  s.note('a', 'widgets', 'tools', 'widget_make');
  s.note('a', 'widgets', 'tools', 'widget_make');
  s.note('b', 'widgets', 'tools', 'widget_list');
  const sum = s.summary('widgets');
  assert.equal(sum.sessions, 2);
  assert.deepEqual(sum.tools, [{ name: 'widget_make', count: 2 }, { name: 'widget_list', count: 1 }]);
  assert.equal(sum.lastUsedAt, new Date(1_700_000_000_000).toISOString());
  assert.deepEqual(s.extensionsFor('a'), ['widgets']);
});

test('a builtin extension is never recorded', () => {
  const s = store();
  assert.equal(s.note('a', 'checklist', 'tools', 'add_checklist_item'), false);
  s.noteSkillTotals('a', 'live-a', { 'checklist:checklist': 1 });
  assert.equal(s.summary('checklist'), null);
  assert.deepEqual(s.extensionsFor('a'), []);
  s.flush();
  assert.equal(fs.existsSync(s.file), false, 'nothing to write');
  s.note('a', 'widgets', 'tools', 'widget_make');
  s.flush();
  const onDisk = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.equal(onDisk.extensions.checklist, undefined);
  assert.deepEqual(onDisk.sessions.a.extIds, ['widgets']);
});

test('a hand-placed extension with no provenance is never recorded', () => {
  const s = store();
  assert.equal(s.note('a', 'handmade', 'runtimes', 'box'), false);
  s.noteSkillTotals('a', 'live-a', { handmade: 3 });
  assert.equal(s.summary('handmade'), null);
  assert.deepEqual(s.extensionsFor('a'), []);
  s.note('a', 'widgets', 'tools', 'widget_make');
  s.flush();
  const onDisk = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.equal(onDisk.extensions.handmade, undefined);
  assert.deepEqual(onDisk.sessions.a.extIds, ['widgets']);
});

test('skill totals only count their growth, so a rescan adds nothing twice', () => {
  const s = store();
  s.noteSkillTotals('a', 'live-a', { 'widgets:widgets': 1 });
  s.noteSkillTotals('a', 'live-a', { 'widgets:widgets': 1 });
  s.noteSkillTotals('a', 'live-a', { 'widgets:widgets': 3, 'agent-skills:shared-skill': 1 });
  const sum = s.summary('widgets');
  assert.deepEqual(sum.skills, [{ name: 'widgets', count: 3 }, { name: 'shared-skill', count: 1 }]);
  assert.equal(sum.sessions, 1);
  // A new transcript under the same card (after /clear) counts on its own.
  s.noteSkillTotals('a', 'live-a2', { widgets: 1 });
  assert.equal(s.summary('widgets').skills[0].count, 4);
});

test('persists across a reload and keeps the skill baseline', () => {
  const file = tmpFile();
  const a = store({ file });
  a.note('a', 'widgets', 'runtimes', 'widget-box');
  a.noteSkillTotals('a', 'live-a', { widgets: 2 });
  a.flush();
  const b = store({ file });
  b.noteSkillTotals('a', 'live-a', { widgets: 2 });
  assert.equal(b.summary('widgets').skills[0].count, 2);
  assert.deepEqual(b.summary('widgets').runtimes, [{ name: 'widget-box', count: 1 }]);
  assert.deepEqual(b.extensionsFor('a'), ['widgets']);
});

test('an extension that loses its origin drops out of the session footer list', () => {
  let origin = true;
  const s = store({ isTracked: (id) => id === 'widgets' && origin });
  s.note('a', 'widgets', 'tools', 'widget_make');
  assert.deepEqual(s.extensionsFor('a'), ['widgets']);
  origin = false;
  assert.deepEqual(s.extensionsFor('a'), []);
  assert.equal(s.summary('widgets'), null);
});

test('a control handler with no session counts without a session', () => {
  const s = store();
  s.note(null, 'widgets', 'handlers', 'widgets:refresh');
  assert.equal(s.summary('widgets').sessions, 0);
  assert.deepEqual(s.summary('widgets').handlers, [{ name: 'widgets:refresh', count: 1 }]);
});

test('skillOwnerIn resolves bare, in-repo-plugin and one-skill-plugin names, and refuses a foreign plugin', () => {
  assert.equal(skillOwnerIn(LIST, 'widgets'), 'widgets');
  assert.equal(skillOwnerIn(LIST, 'widgets:widgets'), 'widgets');
  assert.equal(skillOwnerIn(LIST, 'agent-skills:shared-skill'), 'widgets');
  assert.equal(skillOwnerIn(LIST, 'someone-else:widgets'), null);
  assert.equal(skillOwnerIn(LIST, 'unknown'), null);
  assert.equal(bareSkillName('agent-skills:links'), 'links');
});

test('skillReadsIn finds SKILL.md reads in a command line', () => {
  assert.deepEqual(skillReadsIn("sed -n '1,200p' /opt/aw/data/extensions/widgets/skills/widgets/SKILL.md"), ['widgets']);
  assert.deepEqual(skillReadsIn('cat /x/skills/a/SKILL.md /y/skills/a/SKILL.md'), ['a']);
  assert.deepEqual(skillReadsIn('ls skills/'), []);
  assert.deepEqual(skillReadsIn(null), []);
});
