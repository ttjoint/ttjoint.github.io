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
  // 精确映射：一条网页证据对应一个具体 rawId（不是前缀）。
  //
  // 前缀映射适合「同一数据库的百万条记录」，但网页是每篇独立的文档——
  // 用 `raw:web` 前缀会把所有文章归到同一个证据节点，那就等于说
  // 「蒋作君的简历出自人民网（整个网站）」，追不到具体文章。
  //
  // 映射来源是 evidence 节点的 `note` 字段（格式 `rawRef: <rawId>`），
  // 由抓取脚本写入。这样证据节点自己就声明了「我对应哪条 raw」。
  for (const e of evidenceEntities) {
    const m = String(e.note || '').match(/rawRef:\s*(\S+)/);
    if (m) evidencePrefixes.set(m[1], e.id);
  }

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
      'INSERT OR IGNORE INTO edges (id, subject, predicate, object, qualifiers, valid_from, valid_to, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertProv = db.prepare(
      `INSERT INTO provenance (id, scope, target_id, evidence_id, raw_ref, quote, reason, locator, source_title, commit_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          // 同一 predicate 下的条目先按「事实签名」分组。
          //
          // ## 为什么分组而不是逐条建边
          //
          // 边代表**一个事实**，不是一次证据观测。两个信源说同一件事
          //（同 SPO、同时段、同限定词）时，那是一个事实有两条证据——
          // 应该是一条边 + 两条 provenance。若按证据建边，同一事实会
          // 出现 N 条一模一样的边，页面上重复 N 次，查询也要去重。
          //
          // ## 什么才算「不同事实」
          //
          // 只有事实本身的差异才分边：
          //   时段不同   同一人两次任同一职（1995–2000 / 2005–2010）
          //   观测点不同 两次分别被记载在某一年
          //   限定词不同 一个「嫡长子」一个「庶子」
          // 证据来源不同**不算**——那是同一条边的多个出处。
          //
          // ## 为什么签名里不含证据
          //
          // 早先我把 rawRef+span 放进签名，结果是「每条证据一条边」，
          // 同一事实被两个信源验证就产生两条重复边。这是错的。
          const grouped = new Map();
          for (const entry of entries || []) {
            const rel = splitRelationEntry(entry);
            if (!rel) {
              stats.badRelations = (stats.badRelations || 0) + 1;
              console.warn(`  skip unreadable relation ${e.id} ${predicate}: ${JSON.stringify(entry)}`);
              continue;
            }
            const sig = [
              rel.validFrom == null ? '' : rel.validFrom,
              rel.validTo == null ? '' : rel.validTo,
              rel.observedAt == null ? '' : rel.observedAt,
              rel.qualifiers || '',
            ].join('|');
            const prev = grouped.get(sig);
            if (prev) {
              // 同事实：合并出处列表，不新建边。
              //
              // 注意 prev 是 { rel, sig } 包装对象，provenance 在 prev.rel 上。
              // 直接写 prev.provenance 会挂到包装对象上，而 build 读的是
              // rel.provenance——结果是「边合并了，但第二条证据静默丢失」。
              if (rel.provenance) {
                prev.rel.provenance = (prev.rel.provenance || []).concat(rel.provenance);
              }
              stats.mergedSameFact = (stats.mergedSameFact || 0) + 1;
            } else {
              grouped.set(sig, { rel, sig });
            }
          }

          for (const { rel, sig } of grouped.values()) {
            // 事实签名进 edge id：同时段的两条边 id 相同（合并为一条），
            // 不同时段的两条边 id 不同（各自成条）。
            //
            // 不用证据做签名：同一事实重跑 build 必须得到同一个 id，
            // 否则每次重建边 id 都会漂移，引用旧 id 的出处行全变孤儿。
            const thisEdgeId = edgeId(e.id, canonical, rel.object, sig);

            insertEdge.run(
              thisEdgeId,
              e.id,
              canonical,
              rel.object,
              rel.qualifiers,
              // NULL 表示「时间不详」，不是「没有这条关系」。
              rel.validFrom,
              rel.validTo,
              // 观测点：证据只证明「此刻成立」，不宣称区间。
              rel.observedAt,
            );
            stats.edges++;

            // 边级出处：这条断言出自哪一行原始记录。
            // scope='edge'、target_id=边的 id——schema 早已预留（见 db_schema.js），
            // 只是从未写入过。
            if (rel.provenance) {
              const edgeIdValue = thisEdgeId;
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
                  // locator 存 JSON 字符串。空对象存 null 而不是 '{}'——
                  // 「没有页码」和「页码是空对象」不是一回事，存 '{}' 会让
                  // 「有 locator 的条数」这个统计虚高。
                  p.locator && Object.keys(p.locator).length ? JSON.stringify(p.locator) : null,
                  (p.locator && p.locator.title) || null,
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
            p.locator && Object.keys(p.locator).length ? JSON.stringify(p.locator) : null,
            (p.locator && p.locator.title) || null,
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

  // ---------------------------------------------------------------- 时间下界
  //
  // 必须在实体全部入库后跑：推导要用参与者的生卒/存续期，
  // 而建边时那些数据可能还没写完（人物在 persons 分片，边也在）。
  //
  // 文档 §2.2.1：任何成立的断言，其成立时刻必然落在可推导区间内。
  // 全空等于宣称「任意时刻都可能成立」——那是放弃时间分析。
  const boundsStats = applyTemporalBounds(db, registry);
  stats.boundsInferred = boundsStats.inferred;
  stats.boundsStated = boundsStats.stated;
  stats.boundsObserved = boundsStats.observed;
  stats.boundsUnresolved = boundsStats.unresolved;

  // ---------------------------------------------------------------- 生卒年边
  //
  // 让所有来源的生卒年都变成**边**，统一比较口径。
  //
  // 问题：CBDB 的生卒年只存在 entities.valid_from/valid_to 列里，
  // 网页和维基则产出 birthDate/deathDate 边。于是同一人的两个来源
  // 一个在列上、一个在边上，检测器比不到——实测 multiple-values 恒为 0，
  // 而实际上苏轼的 CBDB 1036 与维基 1037年1月8日 是真实的说法分歧。
  //
  // 列和边不是重复：列是「实体的存续期」（时间切片、时间界推导要用），
  // 边是「某个来源的断言」（多说法比较要用）。同一个人可以有多个来源
  // 的生年断言，但只能有一个存续期——后者由前者推导。
  stats.birthEdges = materializeLifespanEdges(db);

  // 从生卒年边回填实体的存续期。
  //
  // 必须双向打通：
  //   实体列 → 边（materializeLifespanEdges，给 CBDB 这种只有列的）
  //   边 → 实体列（backfillLifespanFromEdges，给维基这种只有边的）
  //
  // 只做单向的话，维基实体的 valid_from/valid_to 全是 null，
  // 于是归并校验里「生卒年不矛盾」条件**永远自动通过**——29 条归并
  // 实际上只是「同名即合并」，没有任何校验。这是实测发现的：
  // 归并置信度分桶时 exact 29 条、near/far 各 0，全部 null 才会这样。
  stats.backfilled = backfillLifespanFromEdges(db);

  // 读入跨来源归并。数据库每次重建，归并表会清空，而归并是人工判断的
  // 结果，不该随重建丢失——权威来源是 data/merges.json。
  stats.merges = loadEntityMerges(db);

  // 冲突标注**不在这里做**。
  //
  // 检测是「判断」，edges 是「事实」。把判断写进事实表有三个问题：
  //   1. 开关检测器要重建整个库（200 秒），实际等于没法开关
  //   2. 单列只能存一个标记，多条检测器命中时会互相覆盖
  //   3. 聚合统计要解析中文 reason（试过，输出 26KB）
  //
  // 改用 sidecar 表 edge_flags，由 scripts/run_detectors.js 独立重算：
  //   node scripts/run_detectors.js            # 全部默认开启的
  //   node scripts/run_detectors.js --off multiple-values
  //   node scripts/run_detectors.js --report   # 看当前统计
  //
  // 建库后如需标注，跑一次上面的命令。

  verify(db, stats);

  const bytes = fs.statSync(OUT).size;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nbuilt ${path.relative(ROOT, OUT)} in ${secs}s`);
  console.log(
    `  entities ${stats.entities}  edges ${stats.edges}  aliases ${stats.aliases}  ` +
      `evidence ${stats.evidence}  provenance ${stats.provenance}  commits ${stats.commits}`,
  );
  console.log(
    `  时间: 原文 ${stats.boundsStated}  观测 ${stats.boundsObserved}  ` +
      `推导 ${stats.boundsInferred}  推不出 ${stats.boundsUnresolved}`,
  );
  console.log(`  生卒年边: ${stats.birthEdges} 条（从实体存续期派生，供多来源比较）`);
  console.log(`  存续期回填: ${stats.backfilled} 个实体（从生卒年边）`);
  console.log(`  跨来源归并: ${stats.merges} 条（data/merges.json）`);
  console.log('  冲突标注：用 node scripts/run_detectors.js 独立重算（不写 edges）');
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
/**
 * 为没有显式时间的边推导时间下界。
 *
 * 三档处理：
 *   attribute   不动（不参与时间切片）
 *   有显式时间  不动（原文优先）
 *   其余        按参与者生卒 + 谓词应然约束推导，标 bounds_source='inferred'
 *
 * 推导不出来的（参与者也无生卒）保持 NULL——诚实地说「推不出来」，
 * 而不是编一个看起来合理的区间。
 */
function applyTemporalBounds(db, registry) {
  const { inferBounds } = require(path.join(ROOT, 'src', 'store', 'temporal_bounds.js'));

  // 一次取出所有需要的实体存续期，避免逐边查询（28 万次查询会很慢）。
  const lifespan = new Map();
  for (const r of db.prepare('SELECT id, valid_from, valid_to FROM entities').all()) {
    lifespan.set(r.id, r);
  }

  const rows = db.prepare(`
    SELECT id, subject, predicate, object, valid_from, valid_to, observed_at
      FROM edges
     WHERE valid_from IS NULL AND valid_to IS NULL AND observed_at IS NULL
  `).all();

  const update = db.prepare(
    'UPDATE edges SET valid_from = ?, valid_to = ?, bounds_source = ? WHERE id = ?',
  );
  // 已有显式时间的边也要标 source，否则「哪些是原文说的」查不出来。
  const markStated = db.prepare(
    "UPDATE edges SET bounds_source = 'stated' WHERE valid_from IS NOT NULL AND bounds_source IS NULL",
  );
  const markObserved = db.prepare(
    "UPDATE edges SET bounds_source = 'observed' WHERE observed_at IS NOT NULL AND bounds_source IS NULL",
  );

  let inferred = 0;
  let unresolved = 0;
  db.exec('BEGIN');
  for (const e of rows) {
    const def = registry.get(e.predicate);
    const temporality = def ? def.temporality : 'concurrent';
    const subj = lifespan.get(e.subject) || null;
    // literal 谓词的 object 不是实体 id，查不到就传 null
    const obj = lifespan.get(e.object) || null;

    const b = inferBounds(e, subj, obj, temporality);
    if (b.boundsSource === 'inferred') {
      update.run(b.validFrom, b.validTo, 'inferred', e.id);
      inferred++;
    } else {
      // 推不出来：保持 NULL。这是真正的缺损，要能被统计到。
      unresolved++;
    }
  }
  markStated.run();
  markObserved.run();
  db.exec('COMMIT');

  return {
    inferred,
    unresolved,
    stated: db.prepare("SELECT COUNT(*) c FROM edges WHERE bounds_source='stated'").get().c,
    observed: db.prepare("SELECT COUNT(*) c FROM edges WHERE bounds_source='observed'").get().c,
  };
}

/**
 * 从实体存续期列生成 birthDate / deathDate 边。
 *
 * 只为「还没有这两个谓词的边」的实体生成——已有边的（网页、维基）
 * 保留它们自己的说法，不能被列值覆盖。否则苏轼的维基说法 1037
 * 会被 CBDB 的 1036 冲掉，冲突就消失了。
 *
 * 客体存年份文本（如「1036年」），与网页/维基的写法同构，
 * 读者在页面上看到的是年份而不是 JDN。
 */
function materializeLifespanEdges(db) {
  const { jdnToYear } = require(path.join(ROOT, 'src', 'time', 'julian.js'));
  const rows = db.prepare(`
    SELECT e.id, e.valid_from, e.valid_to
      FROM entities e
     WHERE e.type = 'person'
       AND (e.valid_from IS NOT NULL OR e.valid_to IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM edges x WHERE x.subject = e.id AND x.predicate = 'birthDate')
       AND NOT EXISTS (SELECT 1 FROM edges x WHERE x.subject = e.id AND x.predicate = 'deathDate')
  `).all();

  const insert = db.prepare(
    'INSERT OR IGNORE INTO edges (id, subject, predicate, object, qualifiers, bounds_source) VALUES (?, ?, ?, ?, NULL, ?)',
  );
  const { edgeId } = require(path.join(ROOT, 'src', 'store', 'db_build_helpers.js'));

  let n = 0;
  db.exec('BEGIN');
  for (const r of rows) {
    if (r.valid_from != null) {
      const y = jdnToYear(r.valid_from);
      const obj = y < 0 ? `前${Math.abs(y)}年` : `${y}年`;
      // bounds_source 标 'entity'：这条边是从实体的存续期列派生的，
      // 不是某个原始文献的直接断言。审计时要能区分。
      insert.run(edgeId(r.id, 'birthDate', obj, 'entity'), r.id, 'birthDate', obj, 'entity');
      n++;
    }
    if (r.valid_to != null) {
      const y = jdnToYear(r.valid_to);
      const obj = y < 0 ? `前${Math.abs(y)}年` : `${y}年`;
      insert.run(edgeId(r.id, 'deathDate', obj, 'entity'), r.id, 'deathDate', obj, 'entity');
      n++;
    }
  }
  db.exec('COMMIT');
  return n;
}

/**
 * 把 data/merges.json 读进 entity_merges 表。
 *
 * 归并是「判断」，不是「事实」，所以它不进 edges/entities，而是一张
 * 可撤销的链接表。撤销只需删 JSON 里那条再重建。
 */
function loadEntityMerges(db) {
  const file = path.join(ROOT, 'data', 'merges.json');
  if (!fs.existsSync(file)) return 0;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`  merges.json 解析失败，跳过归并：${e.message}`);
    return 0;
  }
  const rows = Array.isArray(doc.merges) ? doc.merges : [];
  const insert = db.prepare(
    'INSERT OR REPLACE INTO entity_merges (canonical_id, merged_id, reason, merged_at) VALUES (?, ?, ?, ?)',
  );
  let n = 0;
  db.exec('BEGIN');
  for (const r of rows) {
    if (!r.canonical_id || !r.merged_id) continue;
    // 只接受库里真实存在的实体，防止 JSON 里的陈旧条目引用已删实体。
    const ok = db.prepare('SELECT 1 FROM entities WHERE id = ?').get(r.canonical_id)
      && db.prepare('SELECT 1 FROM entities WHERE id = ?').get(r.merged_id);
    if (!ok) continue;
    insert.run(r.canonical_id, r.merged_id, r.reason || null, r.merged_at || null);
    n++;
  }
  db.exec('COMMIT');
  return n;
}

/**
 * 用 birthDate / deathDate 边回填 entities.valid_from / valid_to。
 *
 * 只填**空的**列——已有的值（CBDB 的原始数据）不能被边覆盖。
 * 一条边取最早/最晚：同一个人可能有多个来源的生年说法，
 * 存续期应该覆盖全部说法，而不是随便挑一个。
 *
 * 用「最早的生年 + 最晚的卒年」会让存续期偏宽。这是**有意**的：
 * 存续期用于时间切片和界推导，偏宽只可能导致「关系在某个时刻
 * 可能成立」被多判为成立，不会漏判。宁可宽，不可错杀。
 */
function backfillLifespanFromEdges(db) {
  const { parseYearMonth, pointRange } = require(path.join(ROOT, 'src', 'time', 'julian.js'));
  const rows = db.prepare(`
    SELECT subject, predicate, object FROM edges
     WHERE predicate IN ('birthDate', 'deathDate')
  `).all();

  const birth = new Map();
  const death = new Map();
  for (const r of rows) {
    const p = parseYearMonth(r.object);
    if (!p) continue;
    const range = pointRange(p);
    if (!range) continue;
    const target = r.predicate === 'birthDate' ? birth : death;
    const cur = target.get(r.subject);
    if (r.predicate === 'birthDate') {
      if (cur == null || range.start < cur) target.set(r.subject, range.start);
    } else if (cur == null || range.end > cur) target.set(r.subject, range.end);
  }

  const upd = db.prepare(`
    UPDATE entities
       SET valid_from = COALESCE(valid_from, ?),
           valid_to   = COALESCE(valid_to, ?)
     WHERE id = ? AND type = 'person'
  `);
  let n = 0;
  db.exec('BEGIN');
  const ids = new Set([...birth.keys(), ...death.keys()]);
  for (const id of ids) {
    const b = birth.get(id) || null;
    const d = death.get(id) || null;
    if (b == null && d == null) continue;
    const before = db.prepare('SELECT valid_from, valid_to FROM entities WHERE id = ?').get(id);
    if (!before) continue;
    if (before.valid_from == null && b != null) n++;
    upd.run(b, d, id);
  }
  db.exec('COMMIT');
  return n;
}

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
