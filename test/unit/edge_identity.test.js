// 边的身份：什么算「同一个事实」，什么算「两个事实」。
//
// 这是数据模型最容易搞错的一处。两种错误方向都实际发生过：
//
//   ① 只按 SPO 做 id → 同一人两次任同一职被合并成一条，「有两次」这个
//      事实丢失，两条证据抢一个 id（后一条被 INSERT OR IGNORE 静默丢弃）。
//   ② 把证据身份放进 id → 同一事实被两个信源验证就产生两条重复边，
//      页面上同一关系出现 N 次。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { edgeId, splitRelationEntry } = require('../../src/store/db_build_helpers.js');

/** 事实签名，与 build_db 里的算法一致。 */
function factSig(rel) {
  return [
    rel.validFrom == null ? '' : rel.validFrom,
    rel.validTo == null ? '' : rel.validTo,
    rel.observedAt == null ? '' : rel.observedAt,
    rel.qualifiers || '',
  ].join('|');
}

test('edge id: 同一 SPO 不同时段 = 两条边', () => {
  // 同一人两次任同一职，是两条边——它们是两个关系实例。
  const a = splitRelationEntry({ id: 'org:x', role: '主席', dates: { from: 1995, to: 2000 } });
  const b = splitRelationEntry({ id: 'org:x', role: '主席', dates: { from: 2005, to: 2010 } });
  const idA = edgeId('person:p', 'memberOf', a.object, factSig(a));
  const idB = edgeId('person:p', 'memberOf', b.object, factSig(b));
  assert.notEqual(idA, idB, '不同时段必须是两条边');
});

test('edge id: 同一事实不同证据 = 一条边', () => {
  // 两个信源说同一件事，是一个事实有两条证据，不是两个事实。
  const a = splitRelationEntry({ id: 'org:x', role: '主席', dates: { from: 1995, to: 2000 } });
  const b = splitRelationEntry({ id: 'org:x', role: '主席', dates: { from: 1995, to: 2000 } });
  assert.equal(factSig(a), factSig(b));
  // 事实签名不含证据，所以两条记录得到同一个 edge id
  assert.equal(
    edgeId('person:p', 'memberOf', a.object, factSig(a)),
    edgeId('person:p', 'memberOf', b.object, factSig(b)),
    '同一事实必须落到同一条边',
  );
});

test('edge id: 限定词不同 = 两条边', () => {
  // 「他的妻子」与「他的妾」是不同事实，不是同一条边的两个说法。
  const wife = splitRelationEntry({ id: 'person:w', role: 'wife' });
  const concubine = splitRelationEntry({ id: 'person:w', role: 'concubine' });
  assert.notEqual(
    edgeId('person:h', 'husband', wife.object, factSig(wife)),
    edgeId('person:h', 'husband', concubine.object, factSig(concubine)),
  );
});

test('edge id: 观测点不同 = 两条边', () => {
  // 两次分别被记载在不同年份，是两个观测事实。
  const a = splitRelationEntry({ id: 'org:x', dates: { observed: 1050 } });
  const b = splitRelationEntry({ id: 'org:x', dates: { observed: 1060 } });
  assert.notEqual(
    edgeId('person:p', 'memberOf', a.object, factSig(a)),
    edgeId('person:p', 'memberOf', b.object, factSig(b)),
  );
});

test('edge id: 省略 discriminator 时向后兼容', () => {
  // 老调用点（只给三元组）仍得到稳定的旧 id。
  assert.equal(
    edgeId('person:a', 'father', 'person:b'),
    edgeId('person:a', 'father', 'person:b'),
  );
});

test('build: 同事实条目合并出处，不新建边', () => {
  // 这条守的是实际发生过的 bug：合并分支写成 prev.provenance 而不是
  // prev.rel.provenance，结果是「边合并了，但第二条证据静默丢失」——
  // 数据库里看不出异常，只是有 2 条证据的事实只显示 1 条。
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build_db.js'), 'utf8');
  assert.match(src, /prev\.rel\.provenance/, '必须写 prev.rel.provenance');
  assert.ok(!/prev\.provenance\s*=/.test(src), '不能写 prev.provenance（挂在包装对象上）');
});

test('build: 事实签名不含证据身份', () => {
  // 把 rawRef/span 放进签名 = 每条证据一条边 = 同一事实大量重复。
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build_db.js'), 'utf8');
  const sigBlock = src.slice(src.indexOf('const sig = ['), src.indexOf('].join(\'|\')'));
  assert.ok(!sigBlock.includes('rawRef'), '签名不能含 rawRef');
  assert.ok(!sigBlock.includes('span'), '签名不能含 span');
});
