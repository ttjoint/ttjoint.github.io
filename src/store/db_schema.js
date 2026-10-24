'use strict';
/**
 * SQLite schema for the derived index.
 *
 * **This database is not authoritative.** Every table here is a projection of
 * files that live outside it:
 *
 *   raw/                              (hash-chained originals, never in the db)
 *   data/<type>/entities/*.json       -> entities / aliases / provenance
 *   data/evidence/entities/*.json     -> evidence
 *   data/commits/commits.jsonl        -> commits
 *
 * `build_db.js` is the only writer and it only ever goes file -> db. There is no
 * write-back path, on purpose: the moment the db becomes writable-by-app it
 * stops being an index and starts being a second source of truth, and the two
 * drift.
 *
 * Why SQLite at all
 * -----------------
 * Not for speed. The reason is that revising layer-1 data used to mean reading
 * 486k JSON files, editing, writing back, then rebuilding indexes — 10+ minutes
 * per pass, with no rollback. Three such passes happened in one afternoon (the
 * dynasty-tag saga). With a database, a revision is one `UPDATE` that can be
 * run, measured, and rolled back. That is the precondition for ever running a
 * bulk extraction bot.
 */

const SCHEMA_VERSION = '1';

/** Statements run in order on a fresh database. */
const DDL = [
  `CREATE TABLE meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  // ---------------------------------------------------------------- entities
  // One row per entity. `props_json` keeps the free-form key/value bag intact:
  // we are not ready to fix that shape, and shredding it now would bake in a
  // decision that P5 is still debating.
  `CREATE TABLE entities (
     id           TEXT PRIMARY KEY,
     type         TEXT NOT NULL,
     name         TEXT NOT NULL,
     summary      TEXT,
     props_json   TEXT,
     -- Julian day numbers, from props. NULL when the entity has no date.
     valid_from   INTEGER,
     valid_to     INTEGER,
     -- which shard directory it came from ('persons', 'organizations', ...)
     folder       TEXT NOT NULL,
     -- Fingerprint of everything this entity claims about itself: name, aliases,
     -- props, edges. Used by materialised views (P3-4) to decide whether a
     -- recomputation is needed without re-reading the shard.
     --
     -- The shards carry no hash of their own (contentHash is a raw-layer field,
     -- covering the source record, not the derived entity). Two different things:
     -- a raw record's hash says "this is the same source bytes"; an entity's hash
     -- says "nothing downstream of this entity needs recomputing".
     content_hash TEXT
   )`,
  `CREATE INDEX idx_entities_type ON entities(type)`,
  `CREATE INDEX idx_entities_name ON entities(name)`,
  `CREATE INDEX idx_entities_time ON entities(valid_from, valid_to)`,
  // Composite index for the timeline: "persons active between X and Y, ordered
  // by time". With only idx_entities_type, SQLite filters by type (485k rows)
  // and then builds a temp B-tree to sort — measured 81ms for a 30-year window.
  // Leading with `type` lets both the range and the ORDER BY come from the index.
  //
  // The trailing `id` is the keyset tiebreak. Without it a cursor page on a time
  // sort degenerates into `MULTI-INDEX OR` (SQLite ORs the range scan with an
  // equality lookup on the boundary value) and must sort: measured 434ms at page
  // 400 of 200. With `id` in the index the same page is a single range seek:
  // 21.8ms. The first page is sub-millisecond either way, so only a deep-cursor
  // benchmark shows the difference.
  `CREATE INDEX idx_entities_type_time ON entities(type, valid_from, id)`,
  // Same shape for a chronology scoped to one folder (no type filter).
  `CREATE INDEX idx_entities_folder_time ON entities(folder, valid_from)`,
  // Keyset pagination is `WHERE folder=? AND name > ? ORDER BY name LIMIT n`.
  // Adding idx_entities_folder_time above made SQLite choose it for that query
  // and sort 486k rows by name in a temp B-tree: 0.07ms -> 575ms. The index it
  // needs is (folder, name); then the range and the ORDER BY both come free.
  `CREATE INDEX idx_entities_folder_name ON entities(folder, name)`,
  // Partial index for the undated cohort.
  //
  // 252,316 of 486,786 persons have no date, and the UI offers a "show undated"
  // toggle. That query is `valid_from IS NULL ORDER BY name LIMIT n`, which a
  // plain index on `valid_from` cannot serve: it finds the NULL block but then
  // has to sort it. Measured 1025ms unsorted-scan, 186ms with analysis.
  //
  // Leading with `name` (not `folder`) is what makes the ORDER BY free. `folder`
  // would force a scan of the whole partial index per folder, which is exactly
  // the shape that is not needed here: the undated toggle is global, and when a
  // folder IS specified SQLite can still filter it from the same index.
  //
  // The trailing `id` is the sort tiebreak (see `compile()`), so including it here
  // makes a keyset page a range seek instead of a scan-and-discard. Measured on
  // 274,309 undated rows: page 400 of 200 costs 249ms with `(name)` and 14.9ms
  // with `(name, id)`. The first page is fast either way, which is why the plain
  // form looked adequate.
  `CREATE INDEX idx_entities_undated ON entities(name, id) WHERE valid_from IS NULL`,

  // ------------------------------------------- type-scoped sorted browsing
  // Every list view is `type=? ORDER BY <sort>, id`. Without these, SQLite seeks
  // idx_entities_type and then sorts the whole type: measured 121ms for
  // `type='person' ORDER BY name` and 164ms for `ORDER BY valid_to`.
  //
  // Why `id` is part of the index and not left to the planner: the cursor's
  // tiebreak is `id`, so an index that stops at `name` still needs a temp B-tree
  // for the last term and still has to scan to the cursor position.
  //
  // Why two indexes and not one: `ORDER BY name` and `ORDER BY valid_to` are
  // different leading columns and no single index can serve both. Adding only
  // `(type,name,id)` made the name sort 0.12ms but pushed `ORDER BY valid_to`
  // from 164ms to 1,971ms, because the planner then had a less bad-looking but
  // much worse option to pick. Both are required, and `db_index.test.js` asserts
  // that the death-date sort keeps its own index.
  //
  // `valid_to` is nullable and `ORDER BY valid_to` therefore sorts NULLs first;
  // an index on the column preserves that order, so no special handling is
  // needed. Cost: about +30MB total on a 355MB database and ~5s of build time.
  //
  // `idx_entities_type_time` carries the same trailing `id` for the birth-date
  // sort; see its definition above.
  `CREATE INDEX idx_entities_type_name_id ON entities(type, name, id)`,
  `CREATE INDEX idx_entities_type_valid_to_id ON entities(type, valid_to, id)`,

  // ----------------------------------------------------------------- aliases
  `CREATE TABLE aliases (
     entity_id TEXT NOT NULL,
     alias     TEXT NOT NULL
   )`,
  `CREATE INDEX idx_aliases_entity ON aliases(entity_id)`,
  `CREATE INDEX idx_aliases_alias  ON aliases(alias)`,

  // ------------------------------------------------------------------- edges
  // The graph is stored as flattened triples, one row per (subject, predicate,
  // object). Shards nest edges as `relations: {predicate: [object, ...]}`, which
  // cannot be queried in either direction without reading the whole file — the
  // single biggest reason a "who are X's children" query used to cost a shard
  // scan per candidate.
  //
  // The id is derived, not stored in the shards: `edge:<sha256(subject|pred|object)>`.
  // References to an edge from outside (a provenance row, a bot's change
  // request, a UI link) need something stable to point at, and shards carry no
  // id of their own.
  `CREATE TABLE edges (
     id         TEXT PRIMARY KEY,
     subject    TEXT NOT NULL,
     predicate  TEXT NOT NULL,
     object     TEXT NOT NULL,
     -- Qualifiers as a JSON object, e.g. {"role":"concubine"}, {"kind":"step"},
     -- {"order":"elder"}. NULL when the edge carries none.
     --
     -- Shards write these either flat, as "kin": ["person:x"], or wrapped,
     -- as "spouse": [{"id": "person:x", "role": "wife"}]. 4,112 of the
     -- wrapped form exist today. The wrappers are not a different kind of edge:
     -- "his spouse, who is his wife" is still a spouse edge, the role just
     -- narrows it. Keeping them as a column rather than folding into the
     -- predicate is what lets the predicate stay the queryable key while the
     -- qualifier answers "which one".
     qualifiers TEXT,
     -- 关系本身的起止时间（年份，可负表公元前）。
     --
     -- 为什么边要带时间（文档 §2.1）：同一对实体的关系可以**分阶段存在**。
     -- 「某人 1995–2000 任某职」与「2005–2010 再任同一职」是两个时段，
     -- 塞进节点等于宣称「一辈子只有一个任职时段」——这是假的。
     --
     -- 为什么允许 NULL：**未知不等于不存在**。「加入致公党时间不详」
     -- 是一条成立的断言，只是缺时间。强制非空会逼人编造日期，
     -- 或者干脆不录入——两者都比留空更糟。
     --
     -- 只有 temporality='concurrent' 的谓词（夫妻/任职/成员）才该填这两个值；
     -- 'persistent'（父母/子女）与 'attribute'（性别/民族）填了也没意义，
     -- 查询层不按它们切片。
     valid_from INTEGER,
     valid_to   INTEGER,
     -- 观测点：证据明确记载「此刻成立」的单一时刻（年）。
     --
     -- 为什么不能只用 valid_from/valid_to（文档 §2.3.1）：
     -- 史料常常只说「某年某月，他任此职」，**没说何时开始、何时结束**。
     -- 把这句话记成 valid_from=1050, valid_to=1050 是伪造精度：它宣称
     -- 关系只存在这一年，而实际可能持续了十年。记成 valid_from=1050,
     -- valid_to=null 也不对：它宣称关系从 1050 年起持续到未知的未来，
     -- 而实际可能在 1051 年就结束。
     --
     -- observed_at 表达的是第三种、也是更诚实的语义：
     -- 「我们有证据证明此关系在该时刻成立，但不宣称它在此之前/之后也存在。」
     -- 这类边在时间切片时命中该点，但不参与区间覆盖判定。
     observed_at INTEGER,
     -- 时间来源：'stated'（原文明确）/ 'observed'（观测点）/ 'inferred'（推导）。
     --
     -- 为什么必须存：推导出的界可能远宽于真实值。读者有权知道
     -- 「这个 1045 年是他出生年推的，不是史料说的」。
     -- 不标注的话，推导值会被当成事实引用——那正是本系统最忌讳的事。
     bounds_source TEXT
   )`,
  // Three indexes, three query shapes. All are used in practice:
  //   subject,predicate -> "X's children"        (the family-tree query)
  //   object,predicate  -> "who has X as child"  (the ancestor query)
  //   predicate,subject -> "all edges of a kind" (stats, distribution charts)
  // The third is not redundant: predicate is not a leading column of the other
  // two, and without it a per-predicate scan measured 111ms vs 0.08ms.
  `CREATE INDEX idx_edges_subject   ON edges(subject, predicate)`,
  `CREATE INDEX idx_edges_object    ON edges(object, predicate)`,
  `CREATE INDEX idx_edges_predicate ON edges(predicate, subject)`,
  // 「某人在 T 年有哪些关系」——时间切片查询。
  //
  // 三个时间列都要能被覆盖：区间查询用 (valid_from, valid_to)，
  // 观测点查询用 observed_at。分开建索引而不是合成一个，因为
  // 两类查询的形态不同（区间命中 vs 等值命中）。
  `CREATE INDEX idx_edges_time ON edges(subject, valid_from, valid_to)`,
  `CREATE INDEX idx_edges_observed ON edges(subject, observed_at) WHERE observed_at IS NOT NULL`,

  // ----------------------------------------------------------------- evidence
  // Evidence nodes: where a claim comes from. Two shapes share this table:
  //   - 'web'      : a URL captured at a point in time.
  //   - 'database' : CBDB. The underlying literature it was compiled from is a
  //                  property (`underlying_sources`), NOT a chain of nodes.
  //                  CBDB's own bibliography is CBDB's claim; stringing it into
  //                  the provenance of an individual claim would record a fact
  //                  that does not belong to that claim.
  `CREATE TABLE evidence (
     id                 TEXT PRIMARY KEY,
     name               TEXT NOT NULL,
     medium             TEXT,
     carrier            TEXT,
     url                TEXT,
     accessed_at        TEXT,
     excerpt            TEXT,
     reliability        TEXT,
     version            TEXT,
     underlying_sources TEXT
   )`,

  // --------------------------------------------------------------- provenance
  // The join between claims and their evidence.
  //
  // `provenance` used to be an array inside each entity shard, and edges had no
  // provenance at all (`relationProvenance` was deferred). They are the same
  // structure: a person proposing "this person exists, and his father is that
  // one" cites one document for both. Keeping them apart was an accident of P1
  // only backfilling entities, not a design decision.
  //
  // scope='entity' -> target_id is an entity id.
  // scope='edge'   -> target_id is an edge id.
  //
  // One target may have MANY rows: a birth year from BIOG_MAIN and a courtesy
  // name from ALTNAME_DATA are two different raw records supporting one entity.
  //
  // raw_ref is NULL for evidence that never entered the raw layer (a web page
  // captured directly as an evidence node). `quote` is NOT NULL in both cases —
  // a claim with no quotable support is not evidence, it is an assertion.
  // 数据质量标注：**判断，不是事实**。
  //
  // 为什么单独一张表而不是 edges 的列：
  //
  //   1. edges 只存事实。判断会随规则变化，写进事实表就把两层混了。
  //   2. 多条检测器可能命中同一条边（「父母出生晚于子女」往往同时
  //      「年龄差越界」）。单列只能存一个，信息会丢；这里一条边多行。
  //   3. 开关检测器不该需要重建整个库。这张表由 scripts/run_detectors.js
  //      独立重算，几秒完成；edges 一条不动。
  //
  // severity: 'conflict'（同一事实多说法，史料分歧，不是错误）
  //           'suspect' （逻辑可疑，可能是录入错，也可能是生年本身是推的）
  // 跨来源实体归并：**链接，不是物理合并**。
  //
  // 没有这张表时，苏轼是两个实体（cbdb-3767 与 wikipedia-xxx），
  // 多说法检测器看不到冲突（它们不在同一 subject 下），页面显示两个
  // 「苏轼」，关系图谱被割裂。
  //
  // 为什么不做物理合并（删一个、搬边到另一个）：
  //
  //   - 两个来源生年不同，合并后只能留一个，另一个说法就丢了
  //   - 归并错了（同名不同人）时，已经搬走的边很难还原
  //   - 无法追溯「这条断言原本属于哪个来源的实体」
  //
  // 建链接则：原始实体和它的边一条不动，查询时把同组视为一个。
  // 归并错了删一行就恢复原状。
  `CREATE TABLE entity_merges (
     canonical_id TEXT NOT NULL,
     merged_id    TEXT NOT NULL,
     reason       TEXT,
     merged_at    TEXT,
     -- 人工判断。自动归并只凭「同名 + 生卒年不矛盾」，对「一方无时间」
     -- 的等于没有校验（纯同名就归并了）。所以人的决定要能记下来：
     --   confirmed  人看过并认可
     --   rejected   人看过并否定（已撤销归并，条目已删）
     --   NULL       自动归并，尚未审查
     status       TEXT,
     reviewed_at  TEXT,
     PRIMARY KEY (merged_id)
   )`,
  `CREATE INDEX idx_entity_merges_canonical ON entity_merges(canonical_id)`,

  `CREATE TABLE edge_flags (
     edge_id     TEXT NOT NULL,
     detector_id TEXT NOT NULL,
     severity    TEXT NOT NULL,
     reason      TEXT,
     detected_at TEXT,
     PRIMARY KEY (edge_id, detector_id)
   )`,
  `CREATE INDEX idx_edge_flags_detector ON edge_flags(detector_id, edge_id)`,
  `CREATE INDEX idx_edge_flags_severity ON edge_flags(severity, detector_id)`,

  `CREATE TABLE provenance (
     id          TEXT PRIMARY KEY,
     scope       TEXT NOT NULL,
     target_id   TEXT NOT NULL,
     evidence_id TEXT NOT NULL,
     raw_ref     TEXT,
     quote       TEXT NOT NULL,
     reason      TEXT,
     -- JSON：{\"sourceId\":2229,\"pages\":\"MQWW PoetID #1761\"}。
     -- 88.9% 的边级出处有它（抽样 20 万条），但此前只存在于分片 JSON 里，
     -- 没进数据库——于是「《宋史》的哪一页」这个查询做不了。
     --
     -- 这是溯源精度所在：raw_ref 指向源记录，locator 指向记录内部的
     -- 页码/条目号。只有 raw_ref 的话，一条边只能追到「CBDB 的某一行」，
     -- 追不到「《宋史》卷 471 页 21a」。
     locator     TEXT,
     -- 文献名，从 CBDB 的 TEXT_CODES 表查得（locator.sourceId → c_title_chn）。
     --
     -- 为什么单独存一列而不是每次从 reason 里解析《…》：
     --   1. 解析字符串不可靠——reason 是给人看的，格式会变；
     --   2. 反向视图要按文献分组统计，有列才能走索引；
     --   3. 「《宋史》支撑了哪些断言」这个问题，答案不该依赖正则。
     source_title TEXT,
     commit_id   TEXT
   )`,
  `CREATE INDEX idx_prov_source_title ON provenance(source_title)`,
  `CREATE INDEX idx_prov_target   ON provenance(target_id)`,
  `CREATE INDEX idx_prov_evidence ON provenance(evidence_id)`,
  `CREATE INDEX idx_prov_raw      ON provenance(raw_ref)`,
  `CREATE INDEX idx_prov_commit   ON provenance(commit_id)`,

  // Which evidence covers which part of the raw layer.
  //
  // 2.47M raw records would each need an evidence id if this were a column, and
  // every one of them would say the same thing ('cbdb'). A prefix mapping says
  // it once: 'raw:cbdb' -> 'evidence:cbdb', 'raw:cbdb/BIOG_MAIN' -> same.
  // Longest prefix wins, so a future source can override one table.
  `CREATE TABLE raw_evidence (
     raw_prefix  TEXT PRIMARY KEY,
     evidence_id TEXT NOT NULL
   )`,

  // ------------------------------------------------------------------ commits
  // A projection of commits.jsonl. The file stays authoritative: it is
  // append-only, and an audit is a single sequential read. The table exists so
  // "what did user 111 change" is a query rather than a full scan.
  `CREATE TABLE commits (
     id          TEXT PRIMARY KEY,
     at          TEXT NOT NULL,
     actor       TEXT,
     summary     TEXT,
     record_json TEXT
   )`,

  // ------------------------------------------------------------ materialised
  // Cached query results (P3-4).
  //
  // A family-tree chart or a statistics panel is expensive to rebuild and changes
  // rarely. Storing the result and the fingerprints of what it read turns "rebuild
  // everything on every data change" into "rebuild only what saw a changed entity".
  //
  // `deps` is a JSON object mapping entity id -> the content_hash it had when the
  // result was computed. A view is stale if any entity's current hash differs, or
  // if the entity no longer exists. Empty object means "depends on nothing", which
  // is legal but means the view cannot be invalidated — used only for constants.
  `CREATE TABLE materialized (
     key        TEXT PRIMARY KEY,
     payload    TEXT NOT NULL,
     deps       TEXT NOT NULL,
     built_at   TEXT NOT NULL
   )`,

  // ------------------------------------------------------------------- counts
  // Precomputed totals. `SELECT COUNT(*)` over 486k rows on every list request
  // is the classic reason a "faceted search" page takes 2 seconds, and it is
  // cheaper to maintain this table than to explain the latency.
  `CREATE TABLE counts (
     key   TEXT PRIMARY KEY,
     value INTEGER NOT NULL
   )`,

  // ---------------------------------------------------------------------- FTS
  // Full-text search over entities.
  //
  // `tokenize='unicode61'` splits on whitespace and punctuation only — it does
  // not segment CJK, so "歐陽景達" stays one token and searching for "景達"
  // matches nothing. Measured: `MATCH '景達'` returned 0 rows against 67
  // organization names.
  //
  // Fix: store a pre-segmented copy in `name_seg` / `aliases_seg` with a space
  // between han characters, and put THOSE in the FTS index. `name` and
  // `aliases` stay verbatim for display. The segmentation is done in build_db
  // (see `segment()`) — cheap at 486k rows, and it keeps the tokenizer rules
  // visible instead of hidden in an unavailable ICU extension.
  //
  // `content=''` keeps the index self-contained: no shadow-table join on read.
  `CREATE VIRTUAL TABLE search USING fts5(
     entity_id UNINDEXED,
     name,
     name_seg,
     aliases,
     aliases_seg,
     summary_seg,
     tokenize = 'unicode61'
   )`,
];

/** Statements that must run after data is loaded (indexes benefit from bulk load). */
const POST_LOAD = [
  // Statistics. Without these the query planner has no idea how large anything
  // is, and it guesses: measured, `valid_from IS NULL ORDER BY name` picked the
  // wrong index and took 186ms instead of 46ms, and a keyset page picked a
  // freshly added index and sorted 486k rows (575ms). Both are planner mistakes
  // that only exist because it was estimating.
  //
  // ANALYZE runs AFTER the indexes are built and the data is loaded, which is the
  // only time the numbers are meaningful. It adds ~40s to a 300s build.
  `ANALYZE`,
  `INSERT INTO counts(key, value) SELECT 'entities', COUNT(*) FROM entities`,
  `INSERT INTO counts(key, value) SELECT 'edges', COUNT(*) FROM edges`,
  `INSERT INTO counts(key, value) SELECT 'evidence', COUNT(*) FROM evidence`,
  `INSERT INTO counts(key, value) SELECT 'provenance', COUNT(*) FROM provenance`,
  `INSERT INTO counts(key, value) SELECT 'commits', COUNT(*) FROM commits`,
  `INSERT INTO counts(key, value) SELECT 'aliases', COUNT(*) FROM aliases`,
];

module.exports = { SCHEMA_VERSION, DDL, POST_LOAD };
