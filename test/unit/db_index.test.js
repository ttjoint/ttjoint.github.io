'use strict';
/**
 * Tests for the SQLite index.
 *
 * These do NOT build the full 486k-row database (that is a 90-second job and
 * belongs in `build_db.js`, not in `npm test`). They build a small database from
 * a temporary data root, which is enough to pin down the parts that were hard to
 * get right and easy to regress:
 *
 *   - the two `relations` shapes (flat string vs wrapped {id, role})
 *   - edge ids being stable, because provenance rows point at them
 *   - provenance -> evidence being resolvable at all (it never was before)
 *   - CJK segmentation in the FTS index
 *   - the indexes that make queries fast actually existing
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { DDL, POST_LOAD } = require('../../src/store/db_schema');

/** Build an in-memory database with the real schema. */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const stmt of DDL) db.exec(stmt);
  return db;
}

/**
 * Re-export the helpers from build_db.js under test.
 *
 * `build_db.js` runs `main()` on require, so the pure helpers live in a
 * separate module that both can import.
 */
const { edgeId, provenanceId, evidenceForRawRef, segment, splitRelationEntry } = require(
  '../../src/store/db_build_helpers.js',
);

test('db: the schema creates every table the design calls for', () => {
  const db = freshDb();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  for (const t of ['entities', 'aliases', 'edges', 'evidence', 'provenance', 'raw_evidence', 'commits', 'counts', 'meta']) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  assert.ok(names.includes('search'), 'missing FTS table');
});

test('db: the three edge indexes exist, including the one that is easy to forget', () => {
  const db = freshDb();
  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edges'")
    .all()
    .map((r) => r.name);
  // Measured before this index existed: a per-predicate scan took 111ms vs
  // 0.08ms. Predicate is not a leading column of either of the other two, so
  // neither can substitute.
  assert.ok(idx.includes('idx_edges_subject'));
  assert.ok(idx.includes('idx_edges_object'));
  assert.ok(idx.includes('idx_edges_predicate'), 'idx_edges_predicate is mandatory');
});

test('db: edge ids are derived from the triple and stable across rebuilds', () => {
  const a = edgeId('person:cbdb-1', 'father', 'person:cbdb-2');
  const b = edgeId('person:cbdb-1', 'father', 'person:cbdb-2');
  assert.equal(a, b, 'same triple must give the same id');
  assert.match(a, /^edge:[0-9a-f]{12}$/);
  // Different triple -> different id, in every position.
  assert.notEqual(a, edgeId('person:cbdb-2', 'father', 'person:cbdb-1'));
  assert.notEqual(a, edgeId('person:cbdb-1', 'mother', 'person:cbdb-2'));
  assert.notEqual(a, edgeId('person:cbdb-1', 'father', 'person:cbdb-3'));
});

test('db: edge ids do not collide across separators', () => {
  // The hash input is `subject\0predicate\0object`. Without a separator that
  // cannot appear in an id, ('a|b','c','d') and ('a','b|c','d') would hash the
  // same string and silently become one edge.
  assert.notEqual(edgeId('a|b', 'c', 'd'), edgeId('a', 'b|c', 'd'));
});

test('db: a plain string relation entry has no qualifiers', () => {
  assert.deepEqual(splitRelationEntry('person:cbdb-2'), {
    object: 'person:cbdb-2',
    qualifiers: null,
    // 边级出处与 qualifiers 分开：前者是「这条断言出自哪里」，
    // 后者是「这条断言怎么成立」。裸字符串没有任何一种。
    provenance: null,
    // 裸字符串也没有时间。
    validFrom: null,
    validTo: null,
    observedAt: null,
  });
});

test('db: a wrapped relation entry keeps its qualifiers and drops the id', () => {
  // 4,112 of these exist today, in three shapes.
  const spouse = splitRelationEntry({ id: 'person:cbdb-9', role: 'wife' });
  assert.equal(spouse.object, 'person:cbdb-9');
  assert.deepEqual(JSON.parse(spouse.qualifiers), { role: 'wife' },
    'the object id must not be duplicated into qualifiers');

  for (const [key, value] of [['kind', 'step'], ['order', 'elder']]) {
    const r = splitRelationEntry({ id: 'person:x', [key]: value });
    assert.deepEqual(JSON.parse(r.qualifiers), { [key]: value });
  }
  // Null-valued keys are not qualifiers.
  assert.equal(splitRelationEntry({ id: 'person:x', role: null }).qualifiers, null);
});

test('db: an unreadable relation entry is rejected rather than half-written', () => {
  // Callers count these instead of inserting a row with object=undefined.
  assert.equal(splitRelationEntry(null), null);
  assert.equal(splitRelationEntry(42), null);
  assert.equal(splitRelationEntry({}), null);
  assert.equal(splitRelationEntry({ id: '' }), null);
});

test('db: raw refs resolve to the longest matching evidence prefix', () => {
  const prefixes = new Map([
    ['raw:cbdb', 'evidence:cbdb'],
    ['raw:cbdb/BIOG_MAIN', 'evidence:biog'],
  ]);
  // Longest prefix wins, so one table can be pointed at a different document
  // without touching the other 2.4M rows.
  assert.equal(evidenceForRawRef('raw:cbdb/BIOG_MAIN/12195', prefixes), 'evidence:biog');
  assert.equal(evidenceForRawRef('raw:cbdb/KIN_DATA/1|2|75', prefixes), 'evidence:cbdb');
  // No match must be null, not a default: a claim whose source cannot be named
  // is a data bug.
  assert.equal(evidenceForRawRef('raw:other/X/1', prefixes), null);
  assert.equal(evidenceForRawRef(null, prefixes), null);
});

test('db: provenance ids differ per row even for the same target', () => {
  // One entity may have several provenance rows (birth year from one table,
  // courtesy name from another). They must not collide.
  const a = provenanceId('person:cbdb-1', 0, 'evidence:cbdb', 'raw:cbdb/BIOG_MAIN/1');
  const b = provenanceId('person:cbdb-1', 1, 'evidence:cbdb', 'raw:cbdb/ALTNAME_DATA/1');
  assert.notEqual(a, b);
  assert.match(a, /^prov:[0-9a-f]{12}$/);
  assert.equal(a, provenanceId('person:cbdb-1', 0, 'evidence:cbdb', 'raw:cbdb/BIOG_MAIN/1'));
});

test('db: CJK segmentation makes names searchable', () => {
  // unicode61 splits on whitespace only, so without segmentation "歐陽景達" is
  // one token and searching "歐陽" matches nothing. Measured on the real shard:
  // 0 hits before, all expected hits after.
  assert.equal(segment('歐陽景達'), '歐 陽 景 達');
  assert.equal(segment('Han Yu'), 'Han Yu', 'latin runs are left alone');

  const db = freshDb();
  db.prepare('INSERT INTO search (entity_id, name, name_seg, aliases, aliases_seg, summary_seg) VALUES (?,?,?,?,?,?)')
    .run('person:x', '歐陽景達', segment('歐陽景達'), '字永叔 醉翁', segment('字永叔 醉翁'), '');
  const hit = (q) => db.prepare('SELECT entity_id FROM search WHERE search MATCH ?').all(segment(q));
  assert.equal(hit('歐陽').length, 1, 'prefix of a name must match');
  assert.equal(hit('景達').length, 1, 'suffix of a name must match');
  assert.equal(hit('醉翁').length, 1, 'alias must match');
  assert.equal(hit('歐陽景達').length, 1, 'the whole name must match');
  assert.equal(hit('不存在的字').length, 0);
});

test('db: counts are populated by POST_LOAD', () => {
  const db = freshDb();
  db.prepare('INSERT INTO entities (id,type,name,folder) VALUES (?,?,?,?)').run('person:a', 'person', 'A', 'persons');
  db.prepare('INSERT INTO edges (id,subject,predicate,object) VALUES (?,?,?,?)').run('edge:1', 'person:a', 'father', 'person:b');
  for (const stmt of POST_LOAD) db.exec(stmt);
  const counts = Object.fromEntries(db.prepare('SELECT key, value FROM counts').all().map((r) => [r.key, r.value]));
  assert.equal(counts.entities, 1);
  assert.equal(counts.edges, 1);
});

test('db: a claim can be traced from entity to source document', () => {
  // This is the whole point of the provenance/evidence split, and it was broken
  // before: entities carried a rawRef, raw records had no evidenceId, and
  // evidence nodes knew nothing about raw. Three islands.
  const db = freshDb();
  db.prepare('INSERT INTO evidence (id, name, medium) VALUES (?,?,?)').run(
    'evidence:cbdb', 'CBDB', 'database',
  );
  db.prepare('INSERT INTO raw_evidence (raw_prefix, evidence_id) VALUES (?,?)').run(
    'raw:cbdb', 'evidence:cbdb',
  );
  db.prepare('INSERT INTO provenance (id, scope, target_id, evidence_id, raw_ref, quote, commit_id) VALUES (?,?,?,?,?,?,?)')
    .run('prov:1', 'entity', 'person:x', 'evidence:cbdb', 'raw:cbdb/BIOG_MAIN/12195', 'c_index_year=412', 'c-000001');

  const row = db
    .prepare(
      `SELECT e.name, p.quote, p.raw_ref, p.commit_id
         FROM provenance p
         JOIN evidence e ON e.id = p.evidence_id
        WHERE p.target_id = ?`,
    )
    .get('person:x');
  assert.equal(row.name, 'CBDB');
  assert.equal(row.quote, 'c_index_year=412');
  assert.equal(row.raw_ref, 'raw:cbdb/BIOG_MAIN/12195');
});

test('db: one target may cite several evidence rows', () => {
  // A person's birth year and courtesy name come from different raw tables.
  const db = freshDb();
  db.prepare('INSERT INTO evidence (id,name) VALUES (?,?)').run('e1', 'BIOG');
  db.prepare('INSERT INTO evidence (id,name) VALUES (?,?)').run('e2', 'ALTNAME');
  const ins = db.prepare('INSERT INTO provenance (id,scope,target_id,evidence_id,quote) VALUES (?,?,?,?,?)');
  ins.run('p1', 'entity', 'person:x', 'e1', 'q1');
  ins.run('p2', 'entity', 'person:x', 'e2', 'q2');
  const n = db.prepare('SELECT COUNT(*) c FROM provenance WHERE target_id=?').get('person:x').c;
  assert.equal(n, 2);
});

test('db: the family-tree query uses an index, not a scan', () => {
  // The plan must not be a full table scan. This is the regression that made
  // the old browser code unusable: it loaded every shard to answer "who is X's
  // father".
  //
  // Either index is acceptable: SQLite may pick idx_edges_subject (subject first)
  // or idx_edges_predicate (predicate first) depending on statistics. Both are
  // covering for this query. What must NOT appear is SCAN edges.
  const db = freshDb();
  const plan = db
    .prepare('EXPLAIN QUERY PLAN SELECT object FROM edges WHERE subject=? AND predicate=?')
    .all('person:x', 'father')
    .map((r) => r.detail)
    .join(' ');
  assert.doesNotMatch(plan, /SCAN edges/, `expected an index, got: ${plan}`);
  assert.match(plan, /USING (COVERING )?INDEX/, `expected an index, got: ${plan}`);
});

test('db: the reverse query uses the object index', () => {
  const db = freshDb();
  const plan = db
    .prepare('EXPLAIN QUERY PLAN SELECT subject FROM edges WHERE object=? AND predicate=?')
    .all('person:x', 'father')
    .map((r) => r.detail)
    .join(' ');
  assert.doesNotMatch(plan, /SCAN edges/, `expected an index, got: ${plan}`);
});

test('db: keyset pagination does not build a temp B-tree', () => {
  // `WHERE folder=? AND name > ? ORDER BY name LIMIT n` is how every list page
  // is fetched. After idx_entities_folder_time was added, SQLite started
  // choosing it here and sorting all 486k rows by name: 0.07ms -> 575ms.
  // idx_entities_folder_name is what makes both the range and the ORDER BY
  // come from the index; without it the regression is silent and correct.
  const db = freshDb();
  const plan = db
    .prepare('EXPLAIN QUERY PLAN SELECT id, name FROM entities WHERE folder=? AND name > ? ORDER BY name LIMIT 50')
    .all('persons', '')
    .map((r) => r.detail)
    .join(' ');
  assert.doesNotMatch(plan, /TEMP B-TREE/, `pagination must not sort, got: ${plan}`);
  assert.match(plan, /idx_entities_folder_name/, `expected idx_entities_folder_name, got: ${plan}`);
});

test('db: the undated partial index exists', () => {
  // query_lang.js pins `dated:false` to this index by name. If it were dropped,
  // every "show undated" request would fail with "no such index" instead of going
  // slow — loudly, but still broken. 252,316 rows depend on it.
  const db = freshDb();
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_entities_undated'")
    .get();
  assert.ok(row, 'idx_entities_undated is referenced by name in query_lang.js');
  assert.match(row.sql, /WHERE valid_from IS NULL/, 'it must stay partial');
});

test('db: the timeline query does not build a temp B-tree', () => {
  // `WHERE type=? AND valid_from BETWEEN ? AND ? ORDER BY valid_from` measured
  // 81ms with only idx_entities_type, because SQLite filtered 485k rows by type
  // and then sorted. idx_entities_type_time brings it to 0.06ms.
  const db = freshDb();
  const plan = db
    .prepare('EXPLAIN QUERY PLAN SELECT id, name FROM entities WHERE type=? AND valid_from BETWEEN ? AND ? ORDER BY valid_from LIMIT 50')
    .all('person', 2100000, 2110000)
    .map((r) => r.detail)
    .join(' ');
  assert.doesNotMatch(plan, /TEMP B-TREE/, `timeline must not sort, got: ${plan}`);
  assert.match(plan, /idx_entities_type_time/, `expected idx_entities_type_time, got: ${plan}`);
});

test('db: name and death-date sorts have their own type-scoped index', () => {
  // These two indexes are a matched pair and must stay that way. Adding only
  // `(type,name,id)` fixes the name sort (121ms -> 0.12ms) but lets the planner
  // pick it for `ORDER BY valid_to`, taking that query from 164ms to 1,971ms.
  // An "optimisation" that removes one of them is a 12x regression on the other.
  const db = freshDb();
  const plan = (sql, ...p) =>
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p).map((r) => r.detail).join(' ');

  const byName = plan('SELECT id FROM entities e WHERE e.type=? ORDER BY e.name, e.id LIMIT 50', 'person');
  assert.match(byName, /idx_entities_type_name_id/, `name sort: ${byName}`);

  const byDeath = plan(
    'SELECT id FROM entities e WHERE e.type=? ORDER BY e.valid_to, e.id LIMIT 50',
    'person',
  );
  assert.match(byDeath, /idx_entities_type_valid_to_id/, `death sort: ${byDeath}`);

  // The cursored form must be a range seek, not a scan-and-filter. Without the
  // trailing `id` in the index the second page still needs a temp B-tree.
  const secondPage = plan(
    'SELECT id FROM entities e WHERE e.type=? AND (e.name, e.id) > (?, ?) ORDER BY e.name, e.id LIMIT 50',
    'person',
    'x',
    'y',
  );
  assert.match(secondPage, /idx_entities_type_name_id/, `keyset page: ${secondPage}`);
});
