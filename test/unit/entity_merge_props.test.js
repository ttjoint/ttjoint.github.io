// 实体合并策略：`replaceProps` 开关。
//
// 默认 `defaultMerge` 让磁盘上的旧记录胜出（`Object.assign({}, rec.props, prev.props)`），
// 这是为了保护人工编辑过的内容不被导入覆盖。
//
// 代价很隐蔽：导入器修正了提取逻辑后重跑，**新值永远写不进去**，而 upsertAll
// 报告「更新 0 条」——看起来像是数据本来就没变。实际踩到的例子是把
// 「1004年」修正为「约 1004年 ± 30」时，18,073 条记录一条都没更新。
//
// `replaceProps` 与既有的 `replaceSources` 同一语义：显式开启才反转优先级。

const test = require('node:test');
const assert = require('node:assert/strict');

const { defaultMerge } = require('../../src/store/entity_writer.js');

const prev = { id: 'person:cbdb-1', name: '張鑑', props: { 逝世时间: '1004年' } };
const rec = { id: 'person:cbdb-1', name: '張鑑', props: { 逝世时间: '约 1004年 ± 30' } };

test('合并: 默认保留磁盘上的 props（保护人工编辑）', () => {
  const out = defaultMerge(prev, rec);
  assert.equal(out.props['逝世时间'], '1004年');
});

test('合并: replaceProps 让重算的 props 生效', () => {
  const out = defaultMerge(prev, rec, { replaceProps: true });
  assert.equal(out.props['逝世时间'], '约 1004年 ± 30');
});

test('合并: replaceProps 不丢弃新记录独有的键', () => {
  const out = defaultMerge(
    { id: 'person:cbdb-1', name: '張鑑', props: { 逝世时间: '1004年' } },
    { id: 'person:cbdb-1', name: '張鑑', props: { 逝世时间: '约 1004年 ± 30', 出生年月: '947年' } },
    { replaceProps: true },
  );
  assert.equal(out.props['出生年月'], '947年');
  assert.equal(out.props['逝世时间'], '约 1004年 ± 30');
});

test('合并: 导入器必须真的传 replaceProps', () => {
  // 光有开关不够——调用方忘了传，行为与修复前完全一样，而且没有任何报错。
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'scripts', 'import_cbdb.js'),
    'utf8',
  );
  assert.match(
    src,
    /upsertAll\('person',\s*cbdbPersons,\s*null,\s*\{[^}]*replaceProps:\s*true/,
    'import_cbdb 必须传 replaceProps，否则重跑无法更新生卒日期',
  );
});

test('合并: replaceRelations 按谓词合并，不误删导入器不产生的边', () => {
  // 名字括注迁移建的边（`郭氏(趙禎妻)` → husband）不在 KIN_DATA 里，
  // 导入器重跑不会重新产生。若整个替换 relations，会静默删掉 2 万多条边。
  const prev = {
    id: 'person:cbdb-4216', name: '郭氏',
    relations: {
      husband: ['person:cbdb-9004'],
      kin: ['person:cbdb-1'],
    },
  };
  const rec = {
    id: 'person:cbdb-4216', name: '郭氏',
    relations: {
      husband: [{ id: 'person:cbdb-9004', provenance: [{ rawRef: 'raw:cbdb/KIN_DATA/4216|9004|134', quote: 'q', reason: 'r', commitId: 'c-1' }] }],
    },
  };
  const out = defaultMerge(prev, rec, { replaceRelations: true });

  // rec 提供的谓词以 rec 为准（带上了出处）
  assert.equal(typeof out.relations.husband[0], 'object');
  assert.equal(out.relations.husband[0].provenance[0].rawRef, 'raw:cbdb/KIN_DATA/4216|9004|134');
  // prev 独有的谓词保留，不能被替换掉
  assert.deepEqual(out.relations.kin, ['person:cbdb-1']);
});

test('合并: 不传 replaceRelations 时 relations 保持磁盘原样', () => {
  const prev = { id: 'p', name: 'n', relations: { father: ['a'] } };
  const rec = { id: 'p', name: 'n', relations: { father: [{ id: 'a', provenance: [] }] } };
  const out = defaultMerge(prev, rec);
  assert.deepEqual(out.relations.father, ['a']);
});

test('合并: superseded 逐条清理，不误删合法兜底边', () => {
  // 映射从 sibling 细化到 brother/sister 后，旧键不能留——否则同一关系
  // 存两遍，页面上显示两次。但粒度必须到条目：
  // 一个人的 sibling 指向三人，两个已细化，第三个源数据只说「是手足」。
  const prev = {
    id: 'p', name: 'n',
    relations: {
      sibling: ['a', 'b', 'c'],
      spouse: ['x'],
    },
  };
  const rec = {
    id: 'p', name: 'n',
    relations: {
      brother: [{ id: 'a', provenance: [] }],
      sister: [{ id: 'b', provenance: [] }],
      // c 没被细化：源数据说不出性别
      husband: [{ id: 'x', provenance: [] }],
    },
  };
  const out = defaultMerge(prev, rec, {
    replaceRelations: true,
    superseded: ['sibling', 'spouse'],
    supersededBy: { sibling: ['brother', 'sister'], spouse: ['husband', 'wife'] },
  });

  // a、b 已细化 → 从 sibling 移除；c 保留
  assert.deepEqual(out.relations.sibling, ['c'], '只应保留未被细化的那条');
  assert.equal(out.relations.brother[0].id, 'a');
  assert.equal(out.relations.sister[0].id, 'b');
  // spouse → husband 已覆盖 x
  assert.equal(out.relations.spouse, undefined);
  assert.equal(out.relations.husband[0].id, 'x');
});

test('合并: 没有细化结果时不删兜底边', () => {
  const prev = { id: 'p', name: 'n', relations: { sibling: ['a'] } };
  const rec = { id: 'p', name: 'n', relations: { father: [{ id: 'z', provenance: [] }] } };
  const out = defaultMerge(prev, rec, {
    replaceRelations: true,
    superseded: ['sibling'],
    supersededBy: { sibling: ['brother', 'sister'] },
  });
  assert.deepEqual(out.relations.sibling, ['a'], '没有细化结果时 sibling 是正确答案');
});

test('合并: ownedPredicates 能删掉导入器修正掉的旧边', () => {
  // CBDB 复合码（`SS`=孫）本该不建边，但早期版本把 11 万条落成了 kin。
  // 修好后重跑，若只按「rec 有就覆盖」处理，这些错误边会因「rec 没产出 kin」
  // 而被保留——错误数据永远清不掉。
  const prev = {
    id: 'p', name: 'n',
    relations: {
      // 旧错误边：带真实出处（它确实来自 KIN_DATA，只是映射错了）
      kin: [{ id: 'x', provenance: [{ rawRef: 'raw:cbdb/KIN_DATA/1|2|243', quote: 'q', reason: 'r', commitId: 'c-1' }] }],
      friend: ['f'],                         // 不属于本次导入，应保留
    },
  };
  const rec = {
    id: 'p', name: 'n',
    relations: { maleChild: [{ id: 'z', provenance: [] }] },
  };
  const out = defaultMerge(prev, rec, {
    replaceRelations: true,
    ownedPredicates: ['kin', 'maleChild', 'father'],
  });

  assert.equal(out.relations.kin, undefined, '带出处的旧错边应被删');
  assert.deepEqual(out.relations.friend, ['f'], '不属于本次导入的谓词要保留');
  assert.equal(out.relations.maleChild[0].id, 'z');
});

test('合并: 不传 ownedPredicates 时保持旧行为（不删无新值的谓词）', () => {
  const prev = { id: 'p', name: 'n', relations: { kin: ['x'] } };
  const rec = { id: 'p', name: 'n', relations: { father: [{ id: 'y', provenance: [] }] } };
  const out = defaultMerge(prev, rec, { replaceRelations: true });
  assert.deepEqual(out.relations.kin, ['x']);
});

test('合并: ownedPredicates 不删无出处的名字括注边', () => {
  // 名字括注迁移建的 kin 边与 KIN_DATA 无关，源数据里没有对应行，
  // 导入器重跑永远不会重新产生。一并删掉就是静默丢数据。
  const prev = {
    id: 'p', name: 'n',
    relations: {
      kin: [
        { id: 'fromKinData', provenance: [{ rawRef: 'raw:cbdb/KIN_DATA/1|2|243', quote: 'q', reason: 'r', commitId: 'c-1' }] },
        'fromNameQualifier',
      ],
    },
  };
  const rec = { id: 'p', name: 'n', relations: {} };
  const out = defaultMerge(prev, rec, {
    replaceRelations: true,
    ownedPredicates: ['kin'],
  });

  assert.deepEqual(out.relations.kin, ['fromNameQualifier'],
    '只应删掉带出处的那条');
});
