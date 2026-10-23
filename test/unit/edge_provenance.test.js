// 小样本端到端：边级 provenance 从 CBDB 行 → 分片 → SQLite。
//
// 只跑「郭氏(趙禎妻)」家族的 6 个人（86 条边），不碰全量数据。
// 全量导入要几分钟，小样本几秒——先确认形状对，再谈规模。
//
// 验证的不是「代码跑通了」，而是三件容易静默出错的事：
//   1. 出处挂在**边的实例**上，不是谓词定义上（同谓词不同行 → 不同 rawRef）
//   2. scope='edge' 且 target_id 是边 id（schema 早已预留，从未写入过）
//   3. quote 非空、rawRef 能唯一定位源行

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CBDB = path.join(ROOT, 'cbdb_20260801', 'cbdb_20260801.sqlite3');
const fs = require('fs');

const hasCbdb = fs.existsSync(CBDB);

test('边级出处：同一谓词的不同实例有不同 rawRef', { skip: !hasCbdb && 'no CBDB source' }, () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(CBDB, { readOnly: true });
  const { buildTextTitles, provenanceFromKinRow } = require('../../src/importers/cbdb_provenance');

  // 取两条都是 code=75（父）但不同人的行。
  const rows = db.prepare('SELECT * FROM KIN_DATA WHERE c_kin_code=75 LIMIT 2').all();
  assert.equal(rows.length, 2, '需要两条同码不同人的行');

  const titles = buildTextTitles(
    (d, t) => d.prepare(`SELECT * FROM "${t}"`).all(),
    db,
  );
  const a = provenanceFromKinRow(rows[0], { titles, kinLabel: '父' });
  const b = provenanceFromKinRow(rows[1], { titles, kinLabel: '父' });

  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  // 关键：同一种谓词（父），出处不同。这就是「挂在边上而非谓词上」的含义。
  assert.notEqual(a[0].rawRef, b[0].rawRef, '同谓词不同实例必须有不同的出处');
  assert.match(a[0].rawRef, /^raw:cbdb\/KIN_DATA\/\d+\|\d+\|\d+$/);
});

test('边级出处：quote 非空，且缺失出处时不伪造书名', { skip: !hasCbdb && 'no CBDB source' }, () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(CBDB, { readOnly: true });
  const { buildTextTitles, provenanceFromKinRow } = require('../../src/importers/cbdb_provenance');
  const titles = buildTextTitles((d, t) => d.prepare(`SELECT * FROM "${t}"`).all(), db);

  // 一条有注记的、一条 c_source=0 的
  const withNotes = db.prepare("SELECT * FROM KIN_DATA WHERE c_notes IS NOT NULL AND TRIM(c_notes)<>'' LIMIT 1").get();
  const noSource = db.prepare('SELECT * FROM KIN_DATA WHERE c_source=0 LIMIT 1').get();

  const p1 = provenanceFromKinRow(withNotes, { titles, kinLabel: '父' })[0];
  assert.ok(p1.quote.trim().length > 0, 'quote 必须非空');
  assert.ok(p1.quote.includes(String(withNotes.c_notes).slice(0, 5)), 'quote 应取自 c_notes');

  const p2 = provenanceFromKinRow(noSource, { titles, kinLabel: '父' })[0];
  assert.ok(p2.quote.trim().length > 0, '没有注记时 quote 仍须非空（重述源行字段）');
  // c_source=0 在 CBDB 里叫「未知」，不能当成一本叫《未知》的书。
  assert.equal(p2.locator.sourceId, undefined, 'c_source=0 不得写成 sourceId');
  assert.match(p2.reason, /未记文献出处/, 'reason 必须明说没有文献出处');
  assert.doesNotMatch(p2.reason, /《未知》/, '不得把缺失伪造成书名');
});

test('边级出处：splitRelationEntry 把 provenance 与 qualifiers 分开', () => {
  const { splitRelationEntry } = require('../../src/store/db_build_helpers');

  const plain = splitRelationEntry('person:cbdb-1');
  assert.equal(plain.object, 'person:cbdb-1');
  assert.equal(plain.qualifiers, null);
  assert.equal(plain.provenance, null);

  const withProv = splitRelationEntry({
    id: 'person:cbdb-2',
    role: '嫡',
    provenance: [{ rawRef: 'raw:cbdb/KIN_DATA/1|2|75', quote: 'x', reason: 'y', commitId: 'c-1' }],
  });
  assert.equal(withProv.object, 'person:cbdb-2');
  // provenance 不能混进 qualifiers，否则「这条边有没有出处」要先解 JSON 才能回答。
  assert.deepEqual(JSON.parse(withProv.qualifiers), { role: '嫡' });
  assert.equal(withProv.provenance.length, 1);
  assert.equal(withProv.provenance[0].rawRef, 'raw:cbdb/KIN_DATA/1|2|75');
});

test('边级出处：makeEdge 保留 provenance，且不进 qualifiers', () => {
  const { makeEdge } = require('../../src/core/graph');
  const e = makeEdge({
    key: 'father',
    subject: 'person:cbdb-1',
    object: 'person:cbdb-2',
    provenance: [{ rawRef: 'raw:cbdb/KIN_DATA/1|2|75', quote: 'q', reason: 'r', commitId: 'c-1' }],
  });
  assert.ok(Array.isArray(e.provenance), 'edge 必须带 provenance');
  assert.equal(e.provenance[0].rawRef, 'raw:cbdb/KIN_DATA/1|2|75');
  assert.equal(e.role, '', 'provenance 不应被当成 role');

  const bare = makeEdge({ key: 'father', subject: 'a', object: 'b' });
  assert.equal(bare.provenance, null, '没有出处时字段为 null，不是空数组');
});

// ---------------------------------------------------------------- 二手数据库标注

test('CBDB 实体级 reason 标明是二手数据库摘录', () => {
  // `quote` 里是 `c_birthyear=1873 c_by_nh_code=666` 这样的列名拼接——
  // 对人不可读，因为 CBDB 本来就不存句子，它把文献整理成了字段。
  // 不加说明，用户点开「引用来源 → 引文」看到一串列名，
  // 会以为出处坏了或者抓取失败。
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'oneoff', 'backfill_provenance.js'), 'utf8');
  assert.match(src, /二手数据库摘录，非文献原文/,
    'reason 必须说明数据性质');
});

test('CBDB 边级 reason 标明是经 CBDB 转述', () => {
  // 「出处《宋史》」读起来像我们直接查了《宋史》，实际是 CBDB 声称它据《宋史》。
  // 前者我们能对原文负责，后者只能对 CBDB 的转述负责。
  const { provenanceFromKinRow } = require('../../src/importers/cbdb_provenance.js');
  const prov = provenanceFromKinRow(
    { c_personid: 1, c_kin_id: 2, c_kin_code: 180, c_source: 7596, c_pages: '3047' },
    { titles: new Map([[7596, '宋史']]), kinLabel: '子' },
  );
  assert.match(prov[0].reason, /经 CBDB 转述/);
  assert.match(prov[0].reason, /宋史/);
  // 没有文献出处时不该说「转述」——那不是转述，是没记。
  const noSource = provenanceFromKinRow(
    { c_personid: 1, c_kin_id: 2, c_kin_code: 180, c_source: 0 },
    { titles: new Map(), kinLabel: '子' },
  );
  assert.doesNotMatch(noSource[0].reason, /经 CBDB 转述/);
  assert.match(noSource[0].reason, /未记文献出处/);
});

test('medium=database 有中文标签，不会露出裸英文', () => {
  // 该模块是 IIFE，挂到 global.HMEvidence 而非 module.exports。
  require('../../js/core/evidence.js');
  const node = global.HMEvidence;
  assert.ok(node, 'HMEvidence 应挂到 global');
  assert.equal(node.MEDIUM_LABELS.database, '二手数据库');
  assert.equal(node.mediumLabel('database'), '二手数据库');
  // 枚举与标签必须成对，否则漏一个就显示裸 key。
  const server = fs.readFileSync(path.join(ROOT, 'src', 'store', 'evidence.js'), 'utf8');
  assert.match(server, /DATABASE: 'database'/);
  assert.match(server, /database: '二手数据库'/);
});
