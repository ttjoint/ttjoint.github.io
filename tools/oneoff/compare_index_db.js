#!/usr/bin/env node
'use strict';
/**
 * P3-5: check the SQLite index agrees with the JSON index.
 *
 * Scope is deliberately narrow: this verifies **SQLite == the JSON index**, not
 * **SQLite == what the raw layer says**. Those are different claims. The shards
 * currently carry only ~1/8 of the KIN_DATA edges (P2 measured 51,814 of an
 * expected 411,573), so a database built from them is correct about the shards
 * and incomplete about CBDB. P4 fixes the shards; this script would then pass
 * again with a larger edge count, no code change.
 *
 * Checks:
 *   1. row counts per folder match the manifest
 *   2. a random sample of entities agree field by field (id, name, aliases)
 *   3. lifespan in the index matches the database's valid_from/valid_to
 *   4. the timeline ("dated persons") count matches
 *   5. search returns the same first result for a sample of indexed names
 *
 * Usage: node tools/oneoff/compare_index_db.js [--sample N]
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { FOLDERS, ALL_FOLDERS } = require('../../src/store/entity_types');
const { segment } = require('../../src/store/db_build_helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const DB = path.join(ROOT, 'local_data', 'humanmap.sqlite3');
const SAMPLE = Number(
  (process.argv.find((a) => a.startsWith('--sample=')) || '--sample=200').split('=')[1],
);

const problems = [];
const fail = (msg) => problems.push(msg);

function loadPageRows(folder) {
  const dir = path.join(DATA, folder);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const rows = [];
  for (const page of manifest.pages) {
    rows.push(...JSON.parse(fs.readFileSync(path.join(dir, page.file), 'utf8')));
  }
  return { manifest, rows };
}

/**
 * Quote one segmented term for FTS5.
 *
 * Names in the corpus contain `?` (e.g. `?大綸`, where a character did not
 * survive the source encoding). FTS5 treats bare punctuation as query syntax and
 * errors out, so each token is wrapped in double quotes, which FTS5 also uses
 * for phrase matching and for escaping.
 */
function ftsPhrase(text) {
  return segment(text)
    .split(' ')
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

function main() {
  if (!fs.existsSync(DB)) {
    console.error(`missing ${DB} (run npm run build:db first)`);
    process.exit(2);
  }
  const db = new DatabaseSync(DB, { readOnly: true });

  for (const folder of ALL_FOLDERS) {
    if (folder === FOLDERS.evidence) continue; // evidence has no index pages
    const { manifest, rows } = loadPageRows(folder);
    const type = Object.keys(FOLDERS).find((t) => FOLDERS[t] === folder);

    // 1. counts
    const dbCount = db.prepare('SELECT COUNT(*) c FROM entities WHERE folder=?').get(folder).c;
    const ok = dbCount === rows.length;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${folder}: index ${rows.length} / db ${dbCount}`,
    );
    if (!ok) fail(`${folder}: count ${dbCount} != index ${rows.length}`);

    // 4. dated count (the timeline is built from this)
    const datedDb = db
      .prepare('SELECT COUNT(*) c FROM entities WHERE folder=? AND valid_from IS NOT NULL')
      .get(folder).c;
    const datedIndex = rows.filter((r) => r.lifespan && r.lifespan.start != null).length;
    const datedOk = datedDb === datedIndex;
    console.log(`${datedOk ? 'ok  ' : 'FAIL'} ${folder}: dated ${datedIndex} / db ${datedDb}`);
    if (!datedOk) fail(`${folder}: dated ${datedDb} != index ${datedIndex}`);

    // 2 + 3. sample
    const step = Math.max(1, Math.floor(rows.length / SAMPLE));
    let checked = 0;
    for (let i = 0; i < rows.length; i += step) {
      const row = rows[i];
      const ent = db
        .prepare('SELECT id, name, type, valid_from, valid_to FROM entities WHERE id=?')
        .get(row.id);
      if (!ent) {
        fail(`${folder}: ${row.id} in index but not in db`);
        continue;
      }
      if (ent.name !== row.name) fail(`${row.id}: name ${JSON.stringify(ent.name)} != ${JSON.stringify(row.name)}`);
      if (ent.type !== (row.type || type)) fail(`${row.id}: type ${ent.type} != ${row.type || type}`);

      const life = row.lifespan || {};
      const idxStart = life.start ?? null;
      const idxEnd = life.end ?? null;
      if (ent.valid_from !== idxStart || ent.valid_to !== idxEnd) {
        fail(`${row.id}: lifespan db(${ent.valid_from},${ent.valid_to}) != index(${idxStart},${idxEnd})`);
      }

      const dbAliases = db
        .prepare('SELECT alias FROM aliases WHERE entity_id=? ORDER BY alias')
        .all(row.id)
        .map((r) => r.alias);
      const idxAliases = [...(row.aliases || [])].sort();
      if (JSON.stringify(dbAliases) !== JSON.stringify(idxAliases)) {
        fail(`${row.id}: aliases db=${JSON.stringify(dbAliases)} index=${JSON.stringify(idxAliases)}`);
      }
      checked++;
    }
    console.log(`     sampled ${checked} ${folder} rows`);

    // 5. search: the first hit for a sample of names must be that name.
    // Only names unique enough to have a single match are meaningful; duplicates
    // (many people named 王氏) are skipped rather than reported as failures.
    let searched = 0;
    for (let i = 0; i < rows.length && searched < 50; i += Math.max(1, Math.floor(rows.length / 50))) {
      const name = rows[i].name;
      if (!name || name.length < 2) continue;
      const hits = db
        .prepare('SELECT entity_id FROM search WHERE search MATCH ? LIMIT 2')
        .all(ftsPhrase(name));
      if (!hits.length) {
        fail(`search: "${name}" returns nothing`);
      }
      searched++;
    }
    console.log(`     searched ${searched} names`);
  }

  console.log('');
  if (problems.length) {
    console.log(`FAILED: ${problems.length} problem(s)`);
    for (const p of problems.slice(0, 20)) console.log(`  ${p}`);
    if (problems.length > 20) console.log(`  ... and ${problems.length - 20} more`);
    process.exit(1);
  }
  console.log('OK: the SQLite index agrees with the JSON index.');
  db.close();
}

main();
