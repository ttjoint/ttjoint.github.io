'use strict';
/**
 * Invariants for the one-off id migration.
 *
 * The migration replaced name-derived ids (`person:sha256(name)`) with opaque
 * origin keys (`person:cbdb-467817`, `person:local-000042`). Three distinct bugs
 * appeared while running it, and none were visible from the outside:
 *
 *   1. It rewrote `relations` and `sources` but not `carrier`, leaving all 111
 *      evidence nodes attributed to entities that no longer existed. Worse, the
 *      local-id renumbering in the same run meant the stale ids still resolved to
 *      *something* — a neighbouring entity — so nothing looked broken.
 *   2. The allocator started from 1 on every run, so a second run slid every local
 *      id by one and quietly invalidated every reference to it.
 *   3. Counter suffixes (`張長（1）`) were stripped into a local variable and never
 *      written back, so 1099 names kept their counters while the report claimed
 *      they had been removed.
 *
 * All three are re-run hazards: the first run looks fine and the damage shows up
 * as drift. The checks below are deliberately about the *shape of the code*, since
 * a behavioural test would have to reproduce the corpus to see them.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const reader = require('../../src/store/data_reader');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'oneoff', 'migrate_opaque_ids.js');
const SRC = fs.readFileSync(SCRIPT, 'utf8');

test('migration: carrier is rewritten alongside relations and sources', () => {
  // `carrier` is an entity reference that lives outside `relations`/`sources`.
  // Treating it as a plain field is exactly what left 111 evidence nodes dangling.
  assert.match(SRC, /ent\.carrier/, 'the migrator must look at evidence.carrier');
  assert.match(SRC, /idMap\.get\(ent\.carrier\)/, 'carrier must go through the id map');
});

test('migration: existing canonical ids are claimed before new ones are issued', () => {
  // Allocating during the walk made the migrator non-idempotent: the first entity
  // without a source key took `local-000001` from the entity that already owned
  // it, and every local id moved down one.
  const preclaim = SRC.indexOf('Claim every id that already looks canonical');
  const allocator = SRC.indexOf('const nextLocal');
  assert.ok(preclaim > 0, 'the pre-claim pass must exist');
  assert.ok(preclaim < allocator, 'pre-claim must come before the allocator is used');
});

test('migration: an id that already belongs to the entity is not a collision', () => {
  // After pre-claiming, `takenKeys` holds every existing id, so the plain
  // `takenKeys.has(newId)` guard fires for the entity's *own* id and reissues it.
  assert.match(SRC, /takenKeys\.has\(newId\)\s*&&\s*newId\s*!==\s*e\.id/);
});

test('migration: a stripped counter suffix is written back to the entity', () => {
  // `report.seqRemoved++` without `ent.name = stripped` is how 1099 names kept
  // their counters while the report claimed they had been removed.
  const at = SRC.indexOf('SEQ_SUFFIX.test(name)');
  assert.ok(at > 0);
  const block = SRC.slice(at, at + 500);
  assert.match(block, /ent\.name = stripped/, 'the stripped name must be assigned');
});

// ---------------------------------------------------------------- the corpus

test('corpus: no id encodes a name', () => {
  // The whole point of the migration. A residual `person:<20 hex>` means a shard
  // was never converted and still collides with every namesake.
  const legacy = [];
  for (const folder of reader.allFolders()) {
    for (const e of reader.readEntities(folder)) {
      const key = String(e.id).split(':')[1] || '';
      if (/^[0-9a-f]{20}$/.test(key)) legacy.push(e.id);
    }
  }
  assert.deepEqual(legacy.slice(0, 5), [], 'these ids are still name hashes');
});

test('corpus: every id parses as type + origin key', () => {
  const ids = require('../../src/store/entity_id');
  const bad = [];
  for (const folder of reader.allFolders()) {
    for (const e of reader.readEntities(folder)) {
      const parsed = ids.parseId(e.id);
      if (!parsed) bad.push(e.id);
      else if (parsed.type !== e.type) bad.push(`${e.id} declares type ${e.type}`);
    }
  }
  assert.deepEqual(bad.slice(0, 5), []);
});

test('corpus: names are atomic — no counters, no relational annotations', () => {
  // `張長（1）` was a collision marker leaking into a display field, and
  // `韓氏(田通妻)` was a spouse relation stuffed into a name. Neither belongs there:
  // identity is the id, and the relation is an edge.
  //
  // Read through the index rather than `readEntities`: the corpus is 486k shards and
  // opening each one takes minutes, while `index/page-*.json` is generated from those
  // same shards and carries exactly the field under test.
  const offenders = [];
  for (const folder of reader.allFolders()) {
    for (const e of reader.readIndexRows(folder)) {
      const name = String(e.name || '');
      if (/[（(]\s*\d+\s*[）)]\s*$/.test(name)) offenders.push(`${e.id} 序号: ${name}`);
      else if (/[（(][^（()）]*[）)]$/.test(name)) offenders.push(`${e.id} 括注: ${name}`);
    }
  }
  assert.deepEqual(offenders.slice(0, 5), []);
});

test('corpus: namesakes exist and are distinguished by data, not by suffixes', () => {
  // Nine CBDB entities are called 韓氏. Under the old scheme they could not all
  // exist, so eight of them were renamed `韓氏（1）`..`韓氏（8）`. They are now nine
  // entities with one name each, told apart by their edges and dates.
  //
  // Read from the index for speed (486k shards); the index is built from the shards
  // by build_index.js, so this is still the corpus, not a separate copy.
  const han = reader.readIndexRows('persons').filter((e) => e.name === '韓氏');
  assert.ok(han.length >= 2, 'expected the corpus to contain several 韓氏');
  assert.equal(new Set(han.map((e) => e.id)).size, han.length, 'namesakes must have distinct ids');
});
