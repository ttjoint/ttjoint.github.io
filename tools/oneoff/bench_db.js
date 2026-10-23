#!/usr/bin/env node
'use strict';
/**
 * P3-6: record a query-latency baseline for the SQLite index.
 *
 * Run this after every schema change. The numbers are the only way to notice
 * that an index disappeared — SQLite will happily answer the same query by
 * scanning, correctly and 1000x slower.
 *
 * Usage: node tools/oneoff/bench_db.js
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { segment } = require('../../src/store/db_build_helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const DB = path.join(ROOT, 'local_data', 'humanmap.sqlite3');

const db = new DatabaseSync(DB, { readOnly: true });

/** Run `fn` n times and report the median, which is less noisy than the mean. */
function bench(label, fn, n = 20) {
  fn(); // warm
  const times = [];
  for (let i = 0; i < n; i++) {
    const s = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(`${median.toFixed(2).padStart(8)} ms  ${label}`);
  return median;
}

/** A person with a real family around them, or any person if none exists. */
function pickSeed() {
  const row = db
    .prepare(
      `SELECT subject FROM edges WHERE predicate IN ('father','maleChild')
        GROUP BY subject HAVING COUNT(*) > 2 LIMIT 1`,
    )
    .get();
  return row ? row.subject : 'person:cbdb-1';
}

const seed = pickSeed();
console.log(`database ${(fs.statSync(DB).size / 1024 / 1024).toFixed(0)} MB, seed ${seed}\n`);

bench('cursor page of 50 entities (keyset)', () =>
  db
    .prepare(
      `SELECT id, name FROM entities WHERE folder='persons' AND name > ?
        ORDER BY name LIMIT 50`,
    )
    .all(''),
);

bench('counts lookup (no COUNT(*))', () => db.prepare(`SELECT value FROM counts WHERE key='persons'`).get());

bench('children of seed (subject,predicate)', () =>
  db.prepare(`SELECT object FROM edges WHERE subject=? AND predicate='maleChild'`).all(seed),
);

bench('parents of seed (reverse)', () =>
  db.prepare(`SELECT object FROM edges WHERE subject=? AND predicate='father'`).all(seed),
);

bench('who has seed as child (object,predicate)', () =>
  db.prepare(`SELECT subject FROM edges WHERE object=? AND predicate='maleChild'`).all(seed),
);

bench('all edges of one predicate', () =>
  db.prepare(`SELECT COUNT(*) c FROM edges WHERE predicate='father'`).get(),
);

bench('upward family tree, depth 5', () =>
  db
    .prepare(
      // Upward means "edges whose subject is me", so the subject index.
      // Same reasoning as the downward query below.
      `WITH RECURSIVE up(id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT e.object, up.depth+1
           FROM edges e INDEXED BY idx_edges_subject, up
          WHERE up.id = e.subject AND e.predicate='father' AND up.depth < 5
       )
       SELECT id, MIN(depth) d FROM up GROUP BY id`,
    )
    .all(seed),
);

bench('downward family tree, depth 5', () =>
  db
    .prepare(
      // INDEXED BY is load-bearing here, not an optimisation hint.
      //
      // Without it SQLite picks idx_edges_predicate because `predicate='father'`
      // is an equality and `down.id = e.object` is a join condition, so it scans
      // every father edge (5,345 today, 91,742 once P4 backfills) and filters,
      // instead of looking up the handful of children of each node. Measured:
      // 13.45ms unindexed vs 0.35ms with the hint — and the gap grows with the
      // edge count, which is exactly what P4 will change.
      //
      // Downward means "edges whose object is me", so the object index.
      `WITH RECURSIVE down(id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT e.subject, down.depth+1
           FROM edges e INDEXED BY idx_edges_object, down
          WHERE down.id = e.object AND e.predicate='father' AND down.depth < 5
       )
       SELECT id, MIN(depth) d FROM down GROUP BY id`,
    )
    .all(seed),
);

bench('FTS prefix search', () =>
  db.prepare(`SELECT entity_id FROM search WHERE search MATCH ? LIMIT 20`).all(segment('歐陽')),
);

bench('timeline window (valid_from range, 30 years)', () =>
  db
    .prepare(
      `SELECT id, name FROM entities
        WHERE type='person' AND valid_from BETWEEN ? AND ?
        ORDER BY valid_from LIMIT 50`,
    )
    .all(2100000, 2110000),
);

bench('provenance of one entity, joined to evidence', () =>
  db
    .prepare(
      `SELECT p.quote, e.name FROM provenance p
         JOIN evidence e ON e.id = p.evidence_id
        WHERE p.target_id = ?`,
    )
    .all('person:cbdb-12195'),
);

bench('alias lookup', () =>
  db.prepare(`SELECT entity_id FROM aliases WHERE alias=? LIMIT 20`).all('安惇'),
);

// ------------------------------------------------------------------ compiler
//
// These go through src/store/query_lang.js rather than raw SQL, because that is
// the path the frontend will actually use. A hand-written query being fast says
// nothing about the compiler's output.

const q = require('../../src/store/query_lang');

bench('compiler: name prefix', () =>
  q.run(db, { where: [{ field: 'name', op: 'prefix', value: '歐陽' }], limit: 20 }),
);

bench('compiler: full-text search', () =>
  q.run(db, { where: [{ field: 'name', op: 'text', value: '安惇' }], limit: 20 }),
);

bench('compiler: timeline window, ordered by time', () =>
  q.run(db, {
    where: [{ field: 'birthDate', op: 'between', value: [2140000, 2170000] }],
    orderBy: [{ field: 'birthDate', dir: 'asc' }],
    limit: 50,
  }),
);

bench('compiler: undated cohort', () =>
  q.run(db, { where: [{ field: 'dated', op: 'eq', value: false }], limit: 50 }),
);

bench('compiler: entities with a father edge', () =>
  q.run(db, { where: [{ field: 'hasPredicate', op: 'eq', value: 'father' }], limit: 20 }),
);

// Paging: the second page must cost the same as the first, which is the whole
// point of keyset cursors. An OFFSET implementation degrades linearly.
const page1 = q.run(db, {
  where: [{ field: 'birthDate', op: 'between', value: [2100000, 2400000] }],
  orderBy: [{ field: 'birthDate', dir: 'asc' }],
  limit: 50,
});
bench('compiler: page 2 via cursor (same cost as page 1?)', () =>
  q.run(db, {
    where: [{ field: 'birthDate', op: 'between', value: [2100000, 2400000] }],
    orderBy: [{ field: 'birthDate', dir: 'asc' }],
    limit: 50,
    cursor: page1.nextCursor,
  }),
);

db.close();
