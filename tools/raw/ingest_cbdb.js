'use strict';
/**
 * Ingest CBDB tables into layer 0.
 *
 * ## Why this exists
 *
 * `scripts/import_cbdb.js` reads the 584 MB SQLite file, maps columns to
 * entities and writes shards, all in one pass. That means the mapping is the
 * only record of what the source said: fix a misread column and you must
 * re-import 486k persons through the same code, and if the new code is still
 * wrong you have overwritten the previous result. Both things have happened in
 * this project (a `c_deathyear` column read as `c_death_year` silently dropped
 * 71,283 death years; a bad regeneration hollowed out 5269 shards).
 *
 * This script does the boring half only: copy rows into `raw/`, unmodified,
 * with a hash chain. Mapping is a separate, versioned, re-runnable step.
 *
 * ## Nothing is interpreted here
 *
 * No column is renamed, no `0` is turned into null, no dated window is applied.
 * CBDB's `0` meaning "unknown" is an interpretation and belongs to the
 * transformer. Keeping it out means a future reader can disagree with us
 * without having to re-download 584 MB.
 *
 * ## Idempotent
 *
 * `rawId` is `<source>-<table>-<composite key>`, so a second run finds every id
 * already present and appends nothing.
 *
 * Usage:
 *   node tools/raw/ingest_cbdb.js                       # all six tables
 *   node tools/raw/ingest_cbdb.js --table=BIOG_MAIN
 *   node tools/raw/ingest_cbdb.js --dry-run
 */

const fs = require('fs');
const path = require('path');

const { makeRecord } = require('../../src/store/raw_schema');
const store = require('../../src/store/raw_store');

const ROOT = path.join(__dirname, '..', '..');
const SQLITE = path.join(ROOT, 'cbdb_20260801', 'cbdb_20260801.sqlite3');

// Composite primary keys, in the order the source declares them. Used to build
// a stable rawId; a row's identity is its key, not its position in the file.
const TABLES = {
  BIOG_MAIN: ['c_personid'],
  KIN_DATA: ['c_personid', 'c_kin_id', 'c_kin_code'],
  POSTED_TO_OFFICE_DATA: ['c_office_id', 'c_posting_id'],
  ALTNAME_DATA: ['c_personid', 'c_alt_name_chn', 'c_alt_name_type_code'],
  ENTRY_DATA: [
    'c_personid', 'c_entry_code', 'c_sequence', 'c_kin_code', 'c_kin_id',
    'c_assoc_code', 'c_assoc_id', 'c_year', 'c_inst_code', 'c_inst_name_code',
  ],
  ASSOC_DATA: [
    'c_assoc_code', 'c_personid', 'c_kin_code', 'c_kin_id', 'c_assoc_id',
    'c_assoc_kin_code', 'c_assoc_kin_id', 'c_assoc_first_year', 'c_text_title',
  ],
};

const BATCH = 5000;

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : def;
}
const DRY = process.argv.includes('--dry-run');
const ONLY = arg('table', null);

/** A composite key has to survive round-tripping through a string. */
function keyFor(row, keyCols) {
  return keyCols
    .map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return '';
      // Slashes and spaces would make the rawId ambiguous when parsed back.
      return String(v).replace(/[|\\/\s]+/g, '_');
    })
    .join('|');
}

async function main() {
  if (!fs.existsSync(SQLITE)) {
    console.error(`CBDB database not found: ${SQLITE}`);
    console.error('Download cbdb_20260801.sqlite3 into cbdb_20260801/ first.');
    process.exit(1);
  }

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  console.log(`reading ${path.basename(SQLITE)} (${(fs.statSync(SQLITE).size / 1024 / 1024).toFixed(0)} MB)...`);
  const db = new SQL.Database(fs.readFileSync(SQLITE));

  const tables = ONLY ? [ONLY] : Object.keys(TABLES);
  for (const t of tables) {
    if (!TABLES[t]) {
      console.error(`unknown table "${t}". Known: ${Object.keys(TABLES).join(', ')}`);
      process.exit(1);
    }
  }

  const capturedAt = new Date().toISOString();
  let grandTotal = 0;

  for (const table of tables) {
    const keyCols = TABLES[table];
    process.stdout.write(`${table.padEnd(24)} `);

    const res = db.exec(`SELECT * FROM ${table}`);
    if (!res.length) {
      console.log('no rows');
      continue;
    }
    const { columns, values } = res[0];

    const total = values.length;
    const seen = new Set();
    const buffer = [];
    let written = 0;
    let skipped = 0;
    let dupKeys = 0;

    for (const tuple of values) {
      const row = {};
      for (let i = 0; i < columns.length; i++) row[columns[i]] = tuple[i];

      const key = keyFor(row, keyCols);
      // The declared composite key is supposed to be unique. If it is not, the
      // second row would silently overwrite the first in the raw store, so
      // count it and make the id distinguishable instead of losing a row.
      let sourceKey = key;
      if (seen.has(key)) {
        dupKeys++;
        sourceKey = `${key}~${seen.size}`;
      }
      seen.add(key);

      const rec = makeRecord({
        source: 'cbdb',
        sourceTable: table,
        sourceKey,
        capturedAt,
        payload: row,
      });

      if (buffer.length >= BATCH) {
        if (!DRY) {
          const r = store.append('cbdb', table, buffer);
          written += r.written;
          skipped += r.skipped;
        }
        buffer.length = 0;
      }
      buffer.push(rec);
    }

    if (buffer.length && !DRY) {
      const r = store.append('cbdb', table, buffer);
      written += r.written;
      skipped += r.skipped;
    }

    grandTotal += total;
    const dupNote = dupKeys ? ` ⚠ ${dupKeys} duplicate keys made distinct` : '';
    console.log(
      `${String(total).padStart(8)} rows` +
      (DRY ? ' (dry run)' : ` | ${written} new, ${skipped} already present`) +
      dupNote,
    );
  }

  if (!DRY) {
    console.log('\nverifying chains...');
    let broken = 0;
    for (const { source, group } of store.listAll()) {
      if (source !== 'cbdb') continue;
      const v = store.verifyGroup(source, group);
      if (!v.ok) {
        broken++;
        console.error(`  ✗ ${group}: ${v.reason} at ${v.brokenAt}`);
      } else {
        console.log(`  ✓ ${group.padEnd(24)} ${v.checked} records`);
      }
    }
    if (broken) process.exit(1);
  }

  console.log(`\ntotal ${grandTotal.toLocaleString()} rows → ${store.rawRoot()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
