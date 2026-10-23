// 把 raw 层的 transformer 接到分片写入流程上。
//
// ## 为什么需要这一层
//
// `src/transformers/*.js` 是 raw 层架构的产物：输入一条 `rawRecord`
// （`raw:cbdb/KIN_DATA/59224|86216|-10000`），输出边。它们从设计起就存在，
// 但**从未被任何导入脚本调用**——`import_cbdb.js` 一直是直接读 SQLite。
//
// 结果是同一份 KIN_DATA 有两套读取路径：
//   raw 层   raw_store.readGroup → transformer.transform   （未接线）
//   SQLite   db.prepare('SELECT * FROM KIN_DATA')          （实际在用）
//
// 两条路都调 `derivePredicate()`，映射逻辑一致，但重复了遍历、码表加载、
// 出处构造。本模块把 raw 层接上，让 transformer 成为唯一的事实来源。
//
// ## 与 SQLite 路径的取舍
//
// raw 层多了两样东西：`rawId`（第 0 层定位，可直接当 provenance.rawRef）
// 和 `contentHash`（内容指纹）。少了 `TEXT_CODES`（书名表不在 raw 层）。
// 所以书名仍从 SQLite 补，其余全部走 raw。
//
// ## 小样本优先
//
// `limit` 参数限制处理的记录数。全量 55.9 万行要几分钟，
// 而验证「接线是否通」只需要几十条——先跑通再加量。

'use strict';

const rawStore = require('../store/raw_store.js');

/**
 * 跑一个 raw 层 transformer。
 *
 * @param {object} transformer  需有 `transform(rawRecord)` 和 `appliesTo`
 * @param {object} opts
 *   @param {number} [opts.limit]      最多处理多少条 raw 记录
 *   @param {function} [opts.filter]   (rawRecord) => boolean，提前过滤
 *   @param {function} [opts.enrich]   (edge, rawRecord) => edge，补 quote/locator 等
 * @returns {{ edges: Array, stats: object }}
 */
function runTransformer(transformer, opts = {}) {
  const { kind, source, sourceTable } = transformer.appliesTo || {};
  if (kind !== 'record' || !source || !sourceTable) {
    throw new Error(`transformer ${transformer.name} does not declare a record source`);
  }

  const limit = Number.isFinite(opts.limit) ? opts.limit : Infinity;
  const filter = opts.filter || null;
  const enrich = opts.enrich || null;

  const edges = [];
  const stats = {
    records: 0,
    edges: 0,
    skippedSelf: 0,
    skippedVague: 0,
    skippedDerived: 0,
    skippedUnknownCode: 0,
    skippedOther: 0,
  };

  for (const rec of rawStore.readGroup(source, sourceTable)) {
    if (stats.records >= limit) break;
    if (filter && !filter(rec)) continue;
    stats.records++;

    const out = transformer.transform(rec);
    if (out.skipped === 'self-reference') { stats.skippedSelf++; continue; }
    if (out.skipped) { stats.skippedOther++; continue; }
    if (out.vagueStep) { stats.skippedVague++; continue; }
    if (out.derivedChart) { stats.skippedDerived++; continue; }

    for (const edge of out.edges || []) {
      // 出处补齐：transformer 只给 rawRef，其余三项（quote/locator/reason）
      // 需要看 payload 才能写，交给调用方注入——它知道文献表在哪。
      edges.push(enrich ? enrich(edge, rec) : edge);
      stats.edges++;
    }
  }

  return { edges, stats };
}

/**
 * 把 transformer 产出的边按 subject 分组，转成分片的 `relations` 形状。
 *
 * 条目用 `{id, provenance}` 而不是裸 id：边级出处必须跟着边走
 * （§6.1「边 provenance = 这条断言出自哪里」）。
 *
 * @param {Array} edges  [{ subject, predicate, object, provenance? }]
 * @returns {Map<string, object>}  subject → { [predicate]: [entry] }
 */
function groupBySubject(edges) {
  const bySubject = new Map();
  for (const e of edges) {
    if (!e.subject || !e.predicate || !e.object) continue;
    if (!bySubject.has(e.subject)) bySubject.set(e.subject, {});
    const rels = bySubject.get(e.subject);
    const bucket = rels[e.predicate] = rels[e.predicate] || [];
    const already = bucket.some((v) => (typeof v === 'string' ? v : v && v.id) === e.object);
    if (already) continue;
    const entry = e.provenance && e.provenance.length
      ? { id: e.object, provenance: e.provenance }
      : e.object;
    if (e.qualifiers && typeof entry === 'object') Object.assign(entry, e.qualifiers);
    bucket.push(entry);
  }
  return bySubject;
}

module.exports = { runTransformer, groupBySubject };
