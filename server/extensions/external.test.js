import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverExternal, unconsentedCapabilities, admitExternal, FORBIDDEN_IMPORTS } from './external.js';
import { loadExtensions, extensionsForGraph } from './index.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ext-discover-'));
}

// The smallest real manifest an installed extension can ship: a default export
// whose id matches the directory it sits in.
function writeExt(root, id, { body, idInManifest = id, requires = [] } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), body ?? `export default {
    id: ${JSON.stringify(idInManifest)},
    label: ${JSON.stringify(`${id} extension`)},
    requires: ${JSON.stringify(requires)},
  };\n`);
  return dir;
}

test('a good manifest is discovered, tagged external and carries its directory', async () => {
  const root = tempRoot();
  writeExt(root, 'notes');
  const found = await discoverExternal({ dir: root, provenance: {} });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'notes');
  assert.equal(found[0].external, true);
  assert.equal(found[0].dir, path.join(root, 'notes'));
  assert.equal(found[0].provenance, null, 'a hand-dropped directory loads with no provenance');
  assert.equal(found[0].quarantine, undefined);
});

test('a missing extensions dir is the ordinary fresh-install state, not an error', async () => {
  assert.deepEqual(await discoverExternal({ dir: path.join(tempRoot(), 'nope'), provenance: {} }), []);
});

test('a bad manifest quarantines rather than throwing', async () => {
  const root = tempRoot();
  writeExt(root, 'nodefault', { body: 'export const notDefault = 1;\n' });
  writeExt(root, 'throws', { body: 'throw new Error("boom");\n' });
  fs.mkdirSync(path.join(root, 'empty'));
  const found = await discoverExternal({ dir: root, provenance: {} });
  const byId = Object.fromEntries(found.map((e) => [e.id, e.quarantine]));
  assert.match(byId.nodefault, /no default-exported manifest/);
  assert.match(byId.throws, /could not load index\.js .*boom/);
  assert.match(byId.empty, /could not load index\.js/);
});

test('a leaf-rule import violation quarantines, and the rule is shared with index.test.js', async () => {
  const root = tempRoot();
  writeExt(root, 'cyclic', { body: "import { SessionManager } from '../../session-manager.js';\nexport default { id: 'cyclic', label: 'Cyclic' };\n" });
  writeExt(root, 'hostapi', { body: "import { buildHostApi } from '../../host-api/index.js';\nexport default { id: 'hostapi', label: 'Host' };\n" });
  writeExt(root, 'entry', { body: "import x from '../../index.js';\nexport default { id: 'entry', label: 'Entry' };\n" });
  // A DYNAMIC import of the same module is deliberately NOT caught — the rule is
  // a correctness guard against closing a boot-breaking module cycle, not a
  // security boundary, and this asserts nothing pretends otherwise.
  writeExt(root, 'dynamic', { body: "export default { id: 'dynamic', label: 'Dyn', load: () => import('../../session-manager.js') };\n" });
  const found = await discoverExternal({ dir: root, provenance: {} });
  const byId = Object.fromEntries(found.map((e) => [e.id, e.quarantine]));
  for (const id of ['cyclic', 'hostapi', 'entry']) assert.match(byId[id], /statically imports a server core module/, id);
  assert.equal(byId.dynamic, undefined, 'a dynamic import is not, and does not claim to be, caught');
  assert.equal(FORBIDDEN_IMPORTS.length, 3);
});

// The most obvious test an extension can ship — a manifest self-check — used to
// quarantine it, with a reason about server core modules it never imported. Two
// independent things had to be wrong for that, and both are asserted here: the
// scan walked test files at all, and a SINGLE-level `../index.js` matched the
// server-entry pattern even though no relative path from an installed
// extension's directory reaches the repo.
test("an extension's own tests are not scanned, and a self-import is not a server import", async () => {
  const root = tempRoot();
  const dir = writeExt(root, 'selfcheck');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'manifest.test.js'), "import ext from '../index.js';\nimport { SessionManager } from '../../session-manager.js';\n");
  // A test file beside the manifest rather than in a test/ directory, skipped by
  // name for the same reason.
  fs.writeFileSync(path.join(dir, 'smoke.test.js'), "import x from '../../host-api/index.js';\n");
  // And a REAL module of the extension's own, self-importing the way any
  // multi-file extension does.
  fs.writeFileSync(path.join(dir, 'tools.js'), "import manifest from '../index.js';\nexport default manifest;\n");
  const found = await discoverExternal({ dir: root, provenance: {} });
  assert.equal(found[0].quarantine, undefined);
});

// A skill ships for an AGENT to read, and may carry a script for it to run;
// nothing in the server's import graph can reach one, so scanning the skills
// directory could only ever produce a false positive — the same argument as
// test files and node_modules. At the root only: a `skills/` directory inside
// the extension's own code is ordinary code.
test("the root skills/ directory is not scanned, but a nested one still is", async () => {
  const root = tempRoot();
  const dir = writeExt(root, 'ships');
  fs.mkdirSync(path.join(dir, 'skills', 'job-worker'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'job-worker', 'SKILL.md'), '---\nname: job-worker\ndescription: d\n---\n');
  fs.writeFileSync(path.join(dir, 'skills', 'job-worker', 'helper.js'), "import { SessionManager } from '../../../session-manager.js';\n");
  assert.equal((await discoverExternal({ dir: root, provenance: {} }))[0].quarantine, undefined);

  fs.mkdirSync(path.join(dir, 'server', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server', 'skills', 'reach.js'), "import x from '../../../state-reader.js';\n");
  assert.match((await discoverExternal({ dir: root, provenance: {} }))[0].quarantine, /server\/skills\/reach\.js/);
});

test('the server entry is still caught from a builtin\'s depth, in a subdirectory too', async () => {
  const root = tempRoot();
  const dir = writeExt(root, 'deep');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'reach.js'), "import x from '../../../index.js';\n");
  const found = await discoverExternal({ dir: root, provenance: {} });
  assert.match(found[0].quarantine, /statically imports a server core module/);
  assert.match(found[0].quarantine, /lib\/reach\.js/);
});

test('node_modules is not scanned for the import rule', async () => {
  const root = tempRoot();
  const dir = writeExt(root, 'deps');
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'i.js'), "import y from '../../../../tmux-scraper.js';\n");
  const found = await discoverExternal({ dir: root, provenance: {} });
  assert.equal(found[0].quarantine, undefined);
});

test('id !== directory name quarantines — the on-disk layout must not lie', async () => {
  const root = tempRoot();
  writeExt(root, 'notes', { idInManifest: 'something-else' });
  const found = await discoverExternal({ dir: root, provenance: {} });
  assert.match(found[0].quarantine, /does not match its directory name "notes"/);
});

test('an external id colliding with a builtin quarantines the EXTERNAL one', async () => {
  const root = tempRoot();
  writeExt(root, 'notes');
  const external = await discoverExternal({ dir: root, provenance: {} });
  const builtin = { id: 'notes', label: 'Shipped notes', dir: path.join(root, 'builtin') };
  // The order primeExtensions uses: builtins first, externals appended.
  const out = loadExtensions({ cfg: {}, builtin: [builtin, ...external] });
  assert.equal(out.list[0].quarantine, null);
  assert.equal(out.list[0].label, 'Shipped notes');
  assert.match(out.list[1].quarantine, /duplicate extension id/);
  assert.equal(out.list[1].external, true);
});

test('requires widened in place after consent quarantines; unchanged or narrowed does not', async () => {
  const root = tempRoot();
  writeExt(root, 'wide', { requires: ['tasks:read', 'sessions:kill'] });
  writeExt(root, 'same', { requires: ['tasks:read'] });
  writeExt(root, 'narrow', { requires: [] });
  const provenance = {
    wide: { id: 'wide', requires: ['tasks:read'] },
    same: { id: 'same', requires: ['tasks:read'] },
    narrow: { id: 'narrow', requires: ['tasks:read'] },
  };
  const found = await discoverExternal({ dir: root, provenance });
  const byId = Object.fromEntries(found.map((e) => [e.id, e.quarantine]));
  assert.match(byId.wide, /widened-and-unconsented requires \(sessions:kill\)/);
  assert.equal(byId.same, undefined);
  assert.equal(byId.narrow, undefined);
});

test('unconsentedCapabilities gates nothing without a record — a hand-dropped directory is its own consent', () => {
  assert.deepEqual(unconsentedCapabilities(['sessions:kill'], null), []);
  assert.deepEqual(unconsentedCapabilities(['sessions:kill'], { id: 'x' }), []);
  assert.deepEqual(unconsentedCapabilities(['a', 'b', 'b'], { requires: ['a'] }), ['b']);
});

// The same checks the install handler runs after ITS import, which is the whole
// reason they live in one function: an install that admitted a manifest boot
// would quarantine reads as an install that silently did nothing.
test('admitExternal applies the id-match and consent checks the install path shares with discovery', () => {
  const base = { id: 'toy', dir: '/tmp/toy', external: true, provenance: { id: 'toy', requires: ['tasks:read'] } };
  assert.deepEqual(admitExternal(null, base), { ok: false, quarantine: 'index.js has no default-exported manifest object' });
  assert.match(admitExternal({ id: 'other' }, base).quarantine, /does not match its directory name "toy"/);
  assert.match(admitExternal({ id: 'toy', requires: ['tasks:read', 'sessions:kill'] }, base).quarantine, /widened-and-unconsented requires \(sessions:kill\)/);
  const ok = admitExternal({ id: 'toy', label: 'Toy', dir: '/its/own/idea', requires: ['tasks:read'] }, base);
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.label, 'Toy');
  assert.equal(ok.entry.dir, '/tmp/toy', 'the discovered path wins over the manifest\'s own');
  assert.equal(ok.entry.external, true);
});

// `pkg` goes in package.json's `wranglerExtension`, the only place issuesRepo
// is read; `manifest` in index.js, where it is ignored.
function writeWithIssuesRepo(root, id, { manifest, pkg, version = '1.0.0', idInManifest = id }) {
  const dir = writeExt(root, id, {
    body: `export default { id: ${JSON.stringify(idInManifest)}, label: 'X'${manifest === undefined ? '' : `, issuesRepo: ${JSON.stringify(manifest)}`} };\n`,
  });
  const declaration = { id, label: 'X', ...(pkg === undefined ? {} : { issuesRepo: pkg }) };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version, wranglerExtension: declaration }));
  return dir;
}

async function graphRows(root, lines = []) {
  const found = await discoverExternal({ dir: root, provenance: {} });
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const graph = extensionsForGraph(loadExtensions({ cfg: {}, builtin: found }).list, () => true, () => ({}));
    loadExtensions({ cfg: {}, builtin: found });
    return Object.fromEntries(graph.map((e) => [e.id, e]));
  } finally {
    console.log = original;
  }
}

test('package.json version and issuesRepo ride the entry, quarantined or not, into the graph', async () => {
  const root = tempRoot();
  writeWithIssuesRepo(root, 'notes', { pkg: 'acme/all-issues', version: '1.4.0' });
  // Quarantined (id mismatch): index.js is not used, and package.json still is.
  writeWithIssuesRepo(root, 'broken', { pkg: 'acme/broken-issues', idInManifest: 'other' });
  writeWithIssuesRepo(root, 'plain', {});
  const bare = writeExt(root, 'bare');
  fs.writeFileSync(path.join(bare, 'package.json'), JSON.stringify({ version: '0.0.1' }));
  writeExt(root, 'nopkg');
  const rows = await graphRows(root);
  assert.equal(rows.notes.version, '1.4.0');
  assert.equal(rows.notes.issuesRepo, 'acme/all-issues');
  assert.ok(rows.broken.quarantine);
  assert.equal(rows.broken.issuesRepo, 'acme/broken-issues');
  assert.equal(rows.plain.issuesRepo, '');
  assert.deepEqual([rows.bare.version, rows.bare.issuesRepo], ['0.0.1', '']);
  assert.deepEqual([rows.nopkg.version, rows.nopkg.issuesRepo], ['', '']);
});

test('issuesRepo comes from package.json only: a manifest copy is ignored silently, never compared', async () => {
  const root = tempRoot();
  writeWithIssuesRepo(root, 'differs', { manifest: 'acme/one', pkg: 'acme/two' });
  writeWithIssuesRepo(root, 'manifestonly', { manifest: 'acme/one' });
  writeWithIssuesRepo(root, 'badmanifest', { manifest: 'not a repo', pkg: 'acme/three' });
  const lines = [];
  const rows = await graphRows(root, lines);
  assert.equal(rows.differs.issuesRepo, 'acme/two');
  assert.equal(rows.manifestonly.issuesRepo, '');
  assert.equal(rows.badmanifest.issuesRepo, 'acme/three');
  for (const id of ['differs', 'manifestonly', 'badmanifest']) assert.equal(rows[id].quarantine, null, id);
  assert.deepEqual(lines.filter((l) => l.includes('issuesRepo')), []);
});

test('an invalid package.json issuesRepo is ignored with one log line, never a quarantine', async () => {
  const root = tempRoot();
  writeWithIssuesRepo(root, 'url', { pkg: 'https://github.com/acme/x' });
  writeWithIssuesRepo(root, 'number', { pkg: 42 });
  const lines = [];
  const rows = await graphRows(root, lines);
  for (const id of ['url', 'number']) {
    assert.equal(rows[id].quarantine, null, id);
    assert.equal(rows[id].issuesRepo, '', id);
  }
  const ignored = lines.filter((l) => l.includes('issuesRepo ignored'));
  assert.equal(ignored.length, 2, 'once each, however often the loader runs');
  assert.ok(ignored.some((l) => l.includes('extension url') && l.includes('not a GitHub "owner/repo"')));
  assert.ok(ignored.some((l) => l.includes('extension number') && l.includes('42')));
});
