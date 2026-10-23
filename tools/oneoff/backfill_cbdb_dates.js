'use strict';
/**
 * Fill in structured dates for persons the last import did not touch.
 *
 * ## The situation
 *
 * `import_cbdb.js` writes the rows it is given. When the year window was removed it
 * rewrote 486k persons, but 159,268 older shards kept the prose field the importer
 * no longer emits:
 *
 *     props['生卒'] = '1751年'
 *
 * Those persons are invisible to every date query — `lifespanFromProps()` reads
 * `出生年月` / `逝世时间` and ignores `生卒`. They also carry the importer's other
 * bug: the string was built from `c_index_year` with 0 rendered literally, so a
 * person with no date could be filed under "0年".
 *
 * `migrate_lifespan_props.js` can convert the string, but the string is lossy — it
 * never contained `c_birthyear` or `c_deathyear`. This script instead re-reads the
 * authoritative CBDB row by `external.cbdbId` and writes the real years, so no
 * information is invented and nothing is lost.
 *
 * Usage: node tools/oneoff/backfill_cbdb_dates.js [--dry-run] [--limit=N]
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { readAll, shardPath } = require('../../src/store/entity_writer');

const ROOT = path.join(__dirname, '..', '..');
const DB = path.join(ROOT, 'cbdb_20260801', 'cbdb_20260801.sqlite3');
const DRY_RUN = process.argv.includes('--dry-run');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

/** CBDB stores unknown years as 0; negative years are real. */
function realYear(y) {
  if (y == null || y === '') return null;
  const n = Number(y);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

function formatYear(n) {
  return n < 0 ? `前${Math.abs(n)}年` : `${n}年`;
}

/**
 * Structured date props for a CBDB row.
 * Mirrors `lifespanProps()` in import_cbdb.js — keep the two in step.
 */
function lifespanProps(row) {
  const indexYear = realYear(row.C_INDEX_YEAR ?? row.c_index_year);
  const birthYear = realYear(row.C_BIRTHYEAR ?? row.c_birthyear);
  const deathYear = realYear(row.C_DEATHYEAR ?? row.c_deathyear);
  const props = {};
  if (birthYear != null) props['出生年月'] = formatYear(birthYear);
  if (deathYear != null) props['逝世时间'] = formatYear(deathYear);
  if (!Object.keys(props).length && indexYear != null) props['生卒'] = formatYear(indexYear);
  return props;
}

async function main() {
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(ROOT, 'node_modules', 'sql.js', 'dist', f),
  });
  const db = new SQL.Database(fs.readFileSync(DB));

  const targets = readAll('person')
    .filter((e) => e.external && e.external.cbdbId && e.props && e.props['生卒']);
  console.log(`待补全（含旧「生卒」串）: ${targets.length}`);

  const stmt = db.prepare('SELECT c_index_year, c_birthyear, c_deathyear FROM BIOG_MAIN WHERE c_personid = ?');
  let updated = 0;
  let cleared = 0;
  let unchanged = 0;
  let missing = 0;
  const samples = [];

  for (const p of targets) {
    if (updated + cleared >= LIMIT) break;
    stmt.reset();
    stmt.bind([p.external.cbdbId]);
    if (!stmt.step()) {
      // The row is gone from CBDB. Leave the entity alone rather than guessing from
      // the lossy string.
      missing++;
      continue;
    }
    const row = stmt.getAsObject();
    const structured = lifespanProps(row);

    const nextProps = { ...p.props };
    delete nextProps['生卒'];
    for (const k of ['出生年月', '逝世时间']) if (structured[k]) nextProps[k] = structured[k];
    if (structured['生卒']) nextProps['生卒'] = structured['生卒'];

    const before = JSON.stringify(p.props);
    const after = JSON.stringify(nextProps);
    if (before === after) { unchanged++; continue; }

    if (samples.length < 5) {
      samples.push(`${p.name}: "${p.props['生卒']}" -> ${JSON.stringify(structured) || '{}（无日期）'}`);
    }
    if (!Object.keys(structured).length) cleared++; else updated++;

    if (!DRY_RUN) {
      p.props = nextProps;
      fs.writeFileSync(shardPath('person', p.id), JSON.stringify(p, null, 2) + '\n', 'utf8');
    }
  }
  stmt.free();
  db.close();

  console.log(`  补全日期: ${updated}`);
  console.log(`  清除无可用日期: ${cleared}`);
  console.log(`  CBDB 中已无此行: ${missing}`);
  console.log(`  无变化: ${unchanged}`);
  for (const s of samples) console.log('  ' + s);
  if (DRY_RUN) console.log('[dry-run] 未写入');
}

main().catch((e) => { console.error(e); process.exit(1); });
