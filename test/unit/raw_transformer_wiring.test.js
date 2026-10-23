// raw 层 transformer 的接线。
//
// `src/transformers/cbdb-kin.js` 从设计起就存在，但**从未被任何导入脚本调用**
// ——`import_cbdb.js` 一直直接读 SQLite。结果是同一份 KIN_DATA 有两套读取路径：
//
//   raw 层   raw_store.readGroup → transformer.transform   （未接线）
//   SQLite   db.prepare('SELECT * FROM KIN_DATA')          （实际在用）
//
// 两条路都调 derivePredicate()，映射一致，但 raw 层多两样东西：
//   rawId        第 0 层定位，可直接当 provenance.rawRef，且能在 raw/ 里核验
//   contentHash  内容指纹
// 而且 raw 层是不可变的原始记录，SQLite 会随 CBDB 换版本而变。
//
// 本测试守住「接线真的通了」：不是测 transform 的逻辑（那个已有测试），
// 而是测 raw_store → runner → 边 这条链没断。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const hasRaw = fs.existsSync(path.join(ROOT, 'raw', 'cbdb', 'KIN_DATA'));

test('runner: raw 记录能变成边', { skip: !hasRaw && 'no raw/ layer' }, () => {
  const { runTransformer } = require('../../src/importers/raw_transformer_runner.js');
  const kin = require('../../src/transformers/cbdb-kin.js');

  // 只挑能出边的码：G/K/P/U 这类模糊码占 KIN_DATA 大多数，
  // 小样本里会把真实结果淹没。
  const GOOD = new Set([75, 76, 111, 112, 180, 181, 134, 135]);
  const { edges, stats } = runTransformer(kin, {
    limit: 300,
    filter: (rec) => GOOD.has(rec.payload.c_kin_code),
  });

  assert.ok(stats.records > 0, '应当读到记录');
  assert.ok(edges.length > 0, '应当产出边');
  for (const e of edges.slice(0, 20)) {
    assert.match(e.subject, /^person:cbdb-\d+$/);
    assert.match(e.object, /^person:cbdb-\d+$/);
    assert.ok(e.predicate, '边必须有谓词');
    assert.match(e.rawRef, /^raw:cbdb\/KIN_DATA\/\d+\|\d+\|\d+$/);
  }
});

test('runner: rawRef 与 raw 层的 rawId 完全一致', { skip: !hasRaw && 'no raw/ layer' }, () => {
  // 这是接线成立的核心证据。如果 rawRef 是拼出来的、与 rawId 不同，
  // 溯源就断链了——出处指向一条在 raw/ 里查不到的记录。
  const { runTransformer } = require('../../src/importers/raw_transformer_runner.js');
  const kin = require('../../src/transformers/cbdb-kin.js');
  const rawStore = require('../../src/store/raw_store.js');

  const GOOD = new Set([75, 76, 111, 112, 180, 181]);
  const { edges } = runTransformer(kin, {
    limit: 200,
    filter: (rec) => GOOD.has(rec.payload.c_kin_code),
  });
  assert.ok(edges.length > 0);

  let checked = 0;
  for (const e of edges.slice(0, 50)) {
    assert.ok(rawStore.exists(e.rawRef), `rawRef 在 raw 层查不到: ${e.rawRef}`);
    checked++;
  }
  assert.ok(checked > 0);
});

test('runner: 复合码与模糊码被跳过，不产生猜测边', { skip: !hasRaw && 'no raw/ layer' }, () => {
  const { runTransformer } = require('../../src/importers/raw_transformer_runner.js');
  const kin = require('../../src/transformers/cbdb-kin.js');

  // 不设 filter，跑原始分布：绝大多数是模糊码。
  const { edges, stats } = runTransformer(kin, { limit: 400 });
  assert.equal(edges.length, 0, '前 400 条应当全是模糊码/复合码');
  assert.ok(stats.skippedVague > 0 || stats.skippedDerived > 0, '应当统计到跳过数');
});

test('runner: 分片条目形状是 {id, provenance}，不是裸 id', { skip: !hasRaw && 'no raw/ layer' }, () => {
  const { runTransformer, groupBySubject } = require('../../src/importers/raw_transformer_runner.js');
  const kin = require('../../src/transformers/cbdb-kin.js');

  const GOOD = new Set([75, 180]);
  const { edges } = runTransformer(kin, {
    limit: 200,
    filter: (rec) => GOOD.has(rec.payload.c_kin_code),
    enrich: (edge, rec) => ({
      ...edge,
      provenance: [{ rawRef: edge.rawRef, locator: {}, quote: 'q', reason: 'r', commitId: 'c-1' }],
    }),
  });
  assert.ok(edges.length > 0);

  const grouped = groupBySubject(edges);
  assert.ok(grouped.size > 0);
  for (const [, rels] of grouped) {
    for (const [pred, entries] of Object.entries(rels)) {
      for (const entry of entries) {
        assert.equal(typeof entry, 'object', `${pred} 的条目应是对象`);
        assert.ok(entry.id, '条目必须有 id');
        assert.ok(Array.isArray(entry.provenance), '条目必须带出处');
      }
    }
  }
});

test('import_cbdb 优先走 raw 层，SQLite 只作回退', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'import_cbdb.js'), 'utf8');
  // 有 raw 层时必须用 transformer；不能退回「只读 SQLite」。
  assert.match(src, /runTransformer\(/, 'import_cbdb 必须调用 raw 层 runner');
  assert.match(src, /raw 层不可用/, '缺少 raw/ 时应有显式回退');
  // 回退路径要留在 catch 里，不能是主路径。
  const idxRunner = src.indexOf('runTransformer(');
  const idxFallback = src.indexOf('raw 层不可用');
  assert.ok(idxFallback > idxRunner, '回退分支应在主路径之后');
});
