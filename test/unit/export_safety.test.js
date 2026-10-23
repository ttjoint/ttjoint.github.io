'use strict';
/**
 * Guards on the export path between the admin database and the shards.
 *
 * ## What went wrong before
 *
 * `scripts/export_static.js` used to `fs.unlinkSync` every file in
 * `data/<type>/entities/` and then rewrite the directory from SQLite. Two things
 * made that dangerous rather than merely inefficient:
 *
 *   1. It bypassed `entity_writer`, the single write path every importer uses.
 *   2. Deleting first means a crash mid-run leaves the corpus partially gone,
 *      and any entity that exists as a shard but not in SQLite is destroyed.
 *
 * The tests below pin the invariants that make the new merge-based export safe.
 * They do not need SQLite: they exercise `upsertAll`, which is the part that
 * decides whether a shard survives.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const writer = require('../../src/store/entity_writer');

/**
 * Run a test body against a throwaway data root.
 *
 * `setDataRoot` rebinds the root the writer resolves on every call, so the test
 * cannot reach the real corpus. An earlier version of this file monkey-patched
 * a captured const instead, which silently wrote test entities into
 * `data/persons/entities/`.
 */
function withTempRoot(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-export-'));
  writer.setDataRoot(tmp);
  try {
    return fn(tmp);
  } finally {
    writer.setDataRoot(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Shards not present in the incoming records must survive
// ---------------------------------------------------------------------------

test('export: a shard missing from the incoming set is not deleted', () => {
  withTempRoot((root) => {
    // Seed one entity that the "export" will never mention.
    const keep = { id: 'person:keep', name: '保留者', type: 'person', props: { 简介: '原有' } };
    const dir = path.join(root, 'persons', 'entities');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, encodeURIComponent(keep.id) + '.json'), JSON.stringify(keep, null, 2) + '\n');

    // Export something unrelated.
    writer.upsertAll('person', [{ id: 'person:new', name: '新增者', type: 'person' }]);

    const files = fs.readdirSync(dir).sort();
    assert.strictEqual(files.length, 2, 'the pre-existing shard must still be there');
    const survivor = JSON.parse(fs.readFileSync(path.join(dir, files.find((f) => f.includes('keep'))), 'utf8'));
    assert.strictEqual(survivor.name, '保留者');
    assert.strictEqual(survivor.props.简介, '原有', 'props must not be dropped');
  });
});

// ---------------------------------------------------------------------------
// Merging must not blank out fields the incoming record omits
// ---------------------------------------------------------------------------

test('export: a record without props does not wipe existing props', () => {
  withTempRoot((root) => {
    const dir = path.join(root, 'organizations', 'entities');
    fs.mkdirSync(dir, { recursive: true });
    const rich = {
      id: 'organization:x',
      name: '某朝',
      type: 'organization',
      props: { 类型: '王朝', 存续: '约前1046年 ~ 前256年' },
      sources: [{ id: 'src-1', name: '史记' }],
    };
    fs.writeFileSync(path.join(dir, encodeURIComponent(rich.id) + '.json'), JSON.stringify(rich, null, 2) + '\n');

    // The admin database shape, which historically omitted props entirely.
    writer.upsertAll('organization', [{ id: 'organization:x', name: '某朝', type: 'organization' }]);

    const after = JSON.parse(fs.readFileSync(path.join(dir, encodeURIComponent(rich.id) + '.json'), 'utf8'));
    assert.deepStrictEqual(after.props, { 类型: '王朝', 存续: '约前1046年 ~ 前256年' });
    assert.strictEqual(after.sources.length, 1);
  });
});

test('export: an empty props object does not erase real props', () => {
  withTempRoot((root) => {
    const dir = path.join(root, 'events', 'entities');
    fs.mkdirSync(dir, { recursive: true });
    const rich = { id: 'event:e', name: '某战', type: 'event', props: { 结果: '胜' } };
    fs.writeFileSync(path.join(dir, encodeURIComponent(rich.id) + '.json'), JSON.stringify(rich, null, 2) + '\n');

    writer.upsertAll('event', [{ id: 'event:e', name: '某战', type: 'event', props: {} }]);

    const after = JSON.parse(fs.readFileSync(path.join(dir, encodeURIComponent(rich.id) + '.json'), 'utf8'));
    assert.deepStrictEqual(after.props, { 结果: '胜' });
  });
});

// ---------------------------------------------------------------------------
// Idempotence and change detection
// ---------------------------------------------------------------------------

test('export: re-exporting unchanged data writes no files', () => {
  withTempRoot(() => {
    const rec = { id: 'person:a', name: '甲', type: 'person', props: { 简介: 'x' } };
    const first = writer.upsertAll('person', [rec]);
    assert.strictEqual(first.written, 1);

    const second = writer.upsertAll('person', [rec]);
    assert.strictEqual(second.written, 0, 'a no-op export must not touch the filesystem');
    assert.strictEqual(second.added, 0);
  });
});

test('export: new sources are appended, not replaced', () => {
  withTempRoot(() => {
    const base = { id: 'person:b', name: '乙', type: 'person', sources: [{ id: 's1', name: '旧来源' }] };
    writer.upsertAll('person', [base]);
    writer.upsertAll('person', [{ id: 'person:b', name: '乙', type: 'person', sources: [{ id: 's2', name: '新来源' }] }]);

    const after = writer.readAll('person').find((e) => e.id === 'person:b');
    assert.deepStrictEqual(after.sources.map((s) => s.id).sort(), ['s1', 's2']);
  });
});

// ---------------------------------------------------------------------------
// Static check on the export script itself
// ---------------------------------------------------------------------------

test('export_static.js: never deletes shard files', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'scripts', 'export_static.js'),
    'utf8',
  );
  assert.ok(!/unlinkSync/.test(src), 'deleting shards before rewriting them is the old, unsafe behaviour');
  assert.ok(!/rmSync/.test(src), 'rmSync has the same failure mode as unlinkSync here');
  assert.ok(/upsertAll/.test(src), 'the export must go through the single write path');
});
