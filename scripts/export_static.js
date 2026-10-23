#!/usr/bin/env node
/**
 * Export SQLite admin edits back into the canonical entity shards.
 *
 * The admin server (`npm run admin`) stores entities in `local_data/humanmap.sqlite3`
 * so they can be edited in a browser. This script is the reverse path: it takes
 * the SQLite contents and makes them authoritative again, then rebuilds the
 * index and re-checks references.
 *
 * ## Why it used to be dangerous
 *
 * The previous version deleted every `.json` in `data/<type>/entities/` and
 * rewrote the directory from scratch. That bypassed `entity_writer` — the single
 * write path the rest of the pipeline assumes — so it re-encoded filenames and
 * dropped the "skip if unchanged" optimisation. It also meant a failed run
 * halfway through left the corpus partially deleted.
 *
 * Now it merges through `upsertAll`, which:
 *   - matches on id then name, so nothing is clobbered by a rename
 *   - writes only files whose content actually changed
 *   - never deletes shards that are absent from SQLite
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const initSqlJs = require('sql.js');
const { upsertAll, readAll } = require('../src/store/entity_writer');

const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'local_data', 'humanmap.sqlite3');

/** Every entity type, from the single shared table. */
const { ALL_TYPES: TYPES } = require('../src/store/entity_types');

/** Load live (non-deleted) entities out of the admin database. */
async function readSqliteEntities() {
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(ROOT, 'node_modules', 'sql.js', 'dist', f),
  });
  const db = new SQL.Database(fs.readFileSync(DB_FILE));

  const rows = [];
  const stmt = db.prepare('SELECT data FROM entities WHERE deleted = 0');
  while (stmt.step()) {
    rows.push(JSON.parse(stmt.getAsObject().data));
  }
  stmt.free();
  db.close();
  return rows;
}

async function main() {
  if (!fs.existsSync(DB_FILE)) {
    throw new Error('local database not found; run: npm run admin');
  }

  const entities = await readSqliteEntities();

  // Evidence id -> url, so the audit merge can tell that an inline object in the
  // review database describes the same article as a reference already on disk.
  const evidenceUrl = {};
  for (const ev of readAll('evidence')) {
    if (ev.id && ev.url) evidenceUrl[ev.id] = ev.url;
  }

  let written = 0;
  let added = 0;
  for (const type of TYPES) {
    const ofType = entities.filter((e) => e.type === type);
    if (!ofType.length) continue;
    const stats = upsertAll(type, ofType, null, { sourcesAudit: true, evidenceUrl });
    written += stats.written;
    added += stats.added;
    console.log(`${type}: ${stats.total} total, ${stats.added} added, ${stats.updated} updated, ${stats.written} written`);
  }

  // Index and reference check are derived from the shards, so they must run
  // after the merge, not before.
  execFileSync(process.execPath, [path.join(__dirname, 'build_index.js')], { cwd: ROOT, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'check_references.js')], { cwd: ROOT, stdio: 'inherit' });

  console.log(`Exported ${entities.length} entities (${written} files changed, ${added} new).`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
