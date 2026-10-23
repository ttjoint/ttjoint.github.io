const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Read the authoritative entity shards, not `index.json`. That file is a
// generated compatibility banner holding only the first page, so tests that
// read it validated 2000 of 5287 entities while reporting success.
const reader = require('../src/store/data_reader');
const FOLDERS = ['persons', 'organizations', 'events'];

test('all entity IDs are stable and unique', () => {
  for (const folder of FOLDERS) {
    const rows = reader.readEntities(folder);
    assert.ok(rows.length > 0, `${folder} is empty`);
    const ids = rows.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `${folder} has duplicate ids`);
    assert.ok(ids.every((x) => String(x).includes(':')), `${folder} has a non namespaced id`);
  }
});

test('all entity detail shards exist', () => {
  for (const folder of FOLDERS) {
    const dir = path.join(__dirname, '..', 'data', folder);
    for (const row of reader.readIndexRows(folder)) {
      // Summary rows name their shard in `detail`; fall back to the id layout.
      const rel = row.detail || `entities/${encodeURIComponent(row.id)}.json`;
      assert.ok(fs.existsSync(path.join(dir, rel)), `${folder}: missing shard for ${row.id}`);
    }
  }
});
