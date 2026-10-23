#!/usr/bin/env node
'use strict';
/**
 * Build the SQLite index from the authoritative files.
 *
 * One direction only: files -> database. There is deliberately no write-back.
 * The database lives at `local_data/humanmap.sqlite3`, which is ignored by git
 * (like `data/` and `raw/`): it is a cache that can be rebuilt at any time.
 *
 * Usage:
 *   node scripts/build_db.js                # full rebuild
 *   node scripts/build_db.js --out X.db     # elsewhere
 *   node scripts/build_db.js --only persons # one folder (debugging)
 *
 * What gets loaded
 * ----------------
 *   entities   <- data/<folder>/entities/*.json   (486k rows, ~8 min)
 *   aliases    <- the same files
 *   edges      <- flattened `relations: {pred: [obj, ...]}`
 *   evidence   <- data/evidence/entities/*.json
 *   provenance <- the `provenance` arrays inside entity shards, plus a synthetic
 *                 evidence:cbdb node so CBDB-backed claims can name their source
 *   commits    <- data/commits/commits.jsonl
 *
 * Edges have no id in the shards. We derive one:
 *   edge:<sha256(subject \0 predicate \0 object)[0..11]>
 * It must be stable across rebuilds, because provenance rows, bot change
 * requests and UI links all refer to it. Hashing the triple (and not a counter)
 * means the same edge keeps its id even if the shard is rewritten.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const { readEntities } = require('../src/store/data_reader');
const { FOLDERS, ALL_FOLDERS } = require('../src/store/entity_types');
const { DDL, POST_LOAD, SCHEMA_VERSION } = require('../src/store/db_schema');
// The four pure helpers live in src/ so the tests can import them without
// running this script, and so the layer-1 write path can compute the same edge
// id this build will compute.
const {
  edgeId,
  provenanceId,
  evidenceForRawRef,
  segment,
  splitRelationEntry,
} = require('../src/store/db_build_helpers');
const { lifespanFromProps } = require('../src/store/graph_source');
const { entityFingerprint } = require('../src/store/materialized');
const { PredicateRegistry } = require('../src/predicates/registry');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const DEFAULT_OUT = path.join(ROOT, 'local_data', 'humanmap.sqlite3');

// One registry for the whole build: `resolve()` maps a Chinese label such as
// `时代` or `母亲` onto its canonical key so the `edges` table holds one spelling
// per predicate. See the canonicalisation note at the insert site.
const registry = new PredicateRegistry();

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const OUT = flag('out') || DEFAULT_OUT;
const ONLY = flag('only');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function main() {
  if (fs.existsSync(OUT)) {
    // Rebuilds are full: a partial update would leave rows whose source shard
    // was deleted still queryable, which is worse than a slow rebuild.
    console.log(`removing existing ${path.relative(ROOT, OUT)}`);
    fs.rmSync(OUT);
  }
  ensureDir(path.dirname(OUT));

  const db = new DatabaseSync(OUT);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = OFF'); // bulk load; a crash just means rebuild
  for (const stmt of DDL) db.exec(stmt);

  const started = Date.now();
  const stats = { entities: 0, aliases: 0, edges: 0, evidence: 0, provenance: 0, commits: 0 };

  // -------------------------------------------------------------- evidence
  // Built first: provenance rows reference it.
  const evidencePrefixes = new Map();
  const insertEvidence = db.prepare(
    `INSERT INTO evidence (id, name, medium, carrier, url, accessed_at, excerpt, reliability, version, underlying_sources)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // CBDB is an evidence node in its own right, not a hidden lens over the raw
  // layer. Without it every ancient claim's source is the internal string
  // "raw:cbdb/BIOG_MAIN/12195", which means nothing to a reader. It is created
  // here rather than in the shards because it is not derived from a shard — it
  // *is* the source those shards came from.
  const CBDB_ID = 'evidence:cbdb';
  const cbdbAnchor = readCorpusAnchor();
  insertEvidence.run(
    CBDB_ID,
    '中國歷代人物傳記資料庫 (CBDB)',
    'database',
    null,
    'https://cbdb.fas.harvard.edu/',
    null,
    '',
    'authoritative',
    'cbdb_20260801',
    // Deliberately a sentence, not a chain of work nodes. CBDB's own
    // bibliography is CBDB's claim: encoding "CBDB cites 宋史 → 宋史 says X" as
    // nodes would attach a fact about CBDB to every individual claim drawn from
    // it. The claim's evidence ends at CBDB, and CBDB's text is the quote.
    '據《中國歷代人物傳記資料庫》編纂所據諸史、方志、文集、墓誌等。' +
      (cbdbAnchor ? ` 語料庫指紋 ${cbdbAnchor}` : ''),
  );
  evidencePrefixes.set('raw:cbdb', CBDB_ID);
  stats.evidence++;

  const evidenceEntities = readEntities(FOLDERS.evidence);
  for (const e of evidenceEntities) {
    insertEvidence.run(
      e.id,
      e.name || e.id,
      e.medium || null,
      e.carrier || null,
      e.url || null,
      e.accessedAt || null,
      e.excerpt || null,
      e.reliability || null,
      e.version || null,
      null,
    );
    stats.evidence++;
  }

  const insertRawEvidence = db.prepare(
    'INSERT INTO raw_evidence (raw_prefix, evidence_id) VALUES (?, ?)',
  );
  for (const [prefix, evId] of evidencePrefixes) insertRawEvidence.run(prefix, evId);

  // -------------------------------------------------------------- entities
  const folders = ONLY ? [ONLY] : ALL_FOLDERS;
  for (const folder of folders) {
    if (folder === FOLDERS.evidence) continue; // loaded above, different shape
    const type = Object.keys(FOLDERS).find((t) => FOLDERS[t] === folder);
    const entities = readEntities(folder);
    console.log(`${folder}: ${entities.length} entities`);

    const insertEntity = db.prepare(
      `INSERT INTO entities (id, type, name, summary, props_json, valid_from, valid_to, folder, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAlias = db.prepare('INSERT INTO aliases (entity_id, alias) VALUES (?, ?)');
    // FTS is written in the same pass. Filling it afterwards with 486k UPDATEs
    // took long enough that the build was killed mid-way with a 260MB WAL;
    // interleaving costs one extra prepared statement and no second scan.
    const insertSearch = db.prepare(
      'INSERT INTO search (entity_id, name, name_seg, aliases, aliases_seg, summary_seg) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertEdge = db.prepare(
      'INSERT OR IGNORE INTO edges (id, subject, predicate, object, qualifiers) VALUES (?, ?, ?, ?, ?)',
    );
    const insertProv = db.prepare(
      `INSERT INTO provenance (id, scope, target_id, evidence_id, raw_ref, quote, reason, commit_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    db.exec('BEGIN');
    try {
      for (const e of entities) {
        const props = e.props || {};
        const life = lifespanFromProps(props);
        // The fingerprint covers the edges too, so it is computed here from the
        // shard rather than derived later from the loaded rows: it must describe
        // what the entity says, and the shard is the authority on that.
        const hash = entityFingerprint({
          id: e.id,
          name: e.name || e.id,
          summary: e.summary || '',
          aliases: e.aliases || [],
          props,
          relations: e.relations || {},
        });
        insertEntity.run(
          e.id,
          e.type || type,
          e.name || e.id,
          e.summary || null,
          Object.keys(props).length ? JSON.stringify(props) : null,
          life ? life.start : null,
          life ? life.end : null,
          folder,
          hash,
        );
        stats.entities++;

        for (const a of e.aliases || []) {
          if (!a) continue;
          insertAlias.run(e.id, a);
          stats.aliases++;
        }

        // Indexed name + aliases. `summary` is left out on purpose:
        // props['简介'] is empty for all 486k persons (P2 measured it), so it
        // would add bytes and match nothing.
        const aliasText = (e.aliases || []).filter(Boolean).join(' ');
        insertSearch.run(
          e.id,
          e.name || e.id,
          segment(e.name || e.id),
          aliasText,
          segment(aliasText),
          '',
        );

        // relations are nested {predicate: [entry, ...]}. Each pair becomes a
        // row so the query can start from either end.
        for (const [predicate, entries] of Object.entries(e.relations || {})) {
          // Canonicalise the key through the registry as a second line of defence.
          // Shards now store canonical keys (see the migration that rewrote
          // `时代` to `era` in 234,819 shards), and predicate_keys.test.js enforces
          // that invariant, so this normally resolves to itself. It is kept because
          // the failure it prevents is silent: a shard written by a future importer
          // that skips the alias table would insert edges under a key that
          // query_lang's field whitelist does not contain — written, never found.
          const canonical = registry.resolve(predicate) || predicate;
          for (const entry of entries || []) {
            const rel = splitRelationEntry(entry);
            if (!rel) {
              stats.badRelations = (stats.badRelations || 0) + 1;
              console.warn(`  skip unreadable relation ${e.id} ${predicate}: ${JSON.stringify(entry)}`);
              continue;
            }
            insertEdge.run(
              edgeId(e.id, canonical, rel.object),
              e.id,
              canonical,
              rel.object,
              rel.qualifiers,
            );
            stats.edges++;

            // 边级出处：这条断言出自哪一行原始记录。
            // scope='edge'、target_id=边的 id——schema 早已预留（见 db_schema.js），
            // 只是从未写入过。
            if (rel.provenance) {
              const edgeIdValue = edgeId(e.id, canonical, rel.object);
              for (const [n, p] of rel.provenance.entries()) {
                const evId = evidenceForRawRef(p.rawRef, evidencePrefixes);
                if (!evId) {
                  stats.edgesWithoutEvidence = (stats.edgesWithoutEvidence || 0) + 1;
                  continue;
                }
                insertProv.run(
                  provenanceId(edgeIdValue, n, evId, p.rawRef),
                  'edge',
                  edgeIdValue,
                  evId,
                  p.rawRef || null,
                  p.quote || '',
                  p.reason || null,
                  p.commitId || 'c-000001',
                );
                stats.edgeProvenance = (stats.edgeProvenance || 0) + 1;
              }
            }
          }
        }

        // Entity-level provenance. The shards keep this array too (decision B:
        // the file stays self-contained), so this table is a projection, not a
        // move.
        for (const [n, p] of (e.provenance || []).entries()) {
          const evId = evidenceForRawRef(p.rawRef, evidencePrefixes);
          if (!evId) {
            // A provenance row pointing nowhere is a data bug, not something to
            // paper over: the claim would read as sourceless.
            throw new Error(`${e.id}: provenance[${n}] rawRef ${p.rawRef} matches no evidence`);
          }
          insertProv.run(
            provenanceId(e.id, n, evId, p.rawRef),
            'entity',
            e.id,
            evId,
            p.rawRef || null,
            p.quote || '',
            p.reason || null,
            p.commitId || null,
          );
          stats.provenance++;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // --------------------------------------------------------------- commits
  stats.commits = loadCommits(db);

  // ---------------------------------------------------------------- finish
  db.exec('BEGIN');
  for (const stmt of POST_LOAD) db.exec(stmt);
  db.exec(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`,
  );
  db.exec(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('built_at', '${new Date().toISOString()}')`,
  );
  db.exec('COMMIT');

  verify(db, stats);

  const bytes = fs.statSync(OUT).size;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nbuilt ${path.relative(ROOT, OUT)} in ${secs}s`);
  console.log(
    `  entities ${stats.entities}  edges ${stats.edges}  aliases ${stats.aliases}  ` +
      `evidence ${stats.evidence}  provenance ${stats.provenance}  commits ${stats.commits}`,
  );
  console.log(`  ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  db.close();
}

/**
 * The corpus anchor is the sha256 of everything in raw/. Recording it inside the
 * CBDB evidence node means a rebuilt index can be told apart from one built
 * against a different snapshot — the same trust chain as the raw layer itself.
 */
function readCorpusAnchor() {
  const p = path.join(ROOT, 'raw', 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).corpusAnchor || null;
  } catch {
    return null;
  }
}

function loadCommits(db) {
  const { readCommits } = require('../src/store/commits.js');
  let all;
  try {
    all = readCommits();
  } catch {
    return 0; // no commit history yet (fresh checkout)
  }
  const insert = db.prepare(
    'INSERT OR REPLACE INTO commits (id, at, actor, summary, record_json) VALUES (?, ?, ?, ?, ?)',
  );
  for (const c of all) {
    // `author` and `message`, not `actor`/`summary` — commits.js owns that shape
    // and it is append-only, so the reader must follow it rather than the reverse.
    insert.run(c.commitId, c.at, c.author || null, c.message || null, JSON.stringify(c));
  }
  return all.length;
}

/** Post-load invariants. A build that "succeeds" with a broken graph is worse than one that fails. */
function verify(db, stats) {
  const one = (sql) => db.prepare(sql).get();
  const ent = one('SELECT COUNT(*) AS c FROM entities').c;
  if (ent !== stats.entities) throw new Error(`entities row count ${ent} != ${stats.entities}`);

  // Edges are inserted with OR IGNORE because a duplicate triple in two shards
  // is a data issue we want to total up, not crash on. Report the difference.
  const edges = one('SELECT COUNT(*) AS c FROM edges').c;
  if (edges !== stats.edges) {
    console.warn(`  note: ${stats.edges - edges} duplicate edge(s) collapsed`);
  }

  // Every provenance row must name an evidence node that exists. This is the
  // link that used to be missing entirely.
  const orphan = one(
    'SELECT COUNT(*) AS c FROM provenance p LEFT JOIN evidence e ON e.id = p.evidence_id WHERE e.id IS NULL',
  ).c;
  if (orphan) throw new Error(`${orphan} provenance rows point at a missing evidence node`);

  const noQuote = one(`SELECT COUNT(*) AS c FROM provenance WHERE quote IS NULL OR TRIM(quote) = ''`).c;
  if (noQuote) throw new Error(`${noQuote} provenance rows have no quote`);

  const fts = one('SELECT COUNT(*) AS c FROM search').c;
  if (fts < ent) console.warn(`  note: search index has ${fts} rows vs ${ent} entities`);
}

main();
