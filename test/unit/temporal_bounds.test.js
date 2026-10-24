// 时间下界推导。
//
// 文档 §2.2.1：任何成立的断言，其成立时刻必然落在可推导的区间内，
// 因为参与者的存在本身就有边界。`valid_from`/`valid_to` 全空等于宣称
// 「这个关系在任意时刻都可能成立」——那放弃了时间分析。
//
// 但推导必须诚实：只用已有数据，不引入外部知识，且标注来源。

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferBounds, AGE_BOUNDS, yearsToDays } = require('../../src/store/temporal_bounds.js');

// 实体时间列存的是 Julian day number，不是年份。
// 用真实的 JDN 基准：1000 年前后约 2086000。
const BIRTH = 2086000;
const DEATH = BIRTH + yearsToDays(70);

test('bounds: 有显式时间时不动', () => {
  // 原文说了什么就是什么，推导不覆盖。
  const r = inferBounds(
    { predicate: 'memberOf', validFrom: 1050, validTo: 1060 },
    { valid_from: BIRTH }, null, 'concurrent',
  );
  assert.equal(r.validFrom, 1050);
  assert.equal(r.validTo, 1060);
  assert.equal(r.boundsSource, 'stated');
});

test('bounds: 观测点自成区间，不推导', () => {
  // 观测点本身就是一个「有界」的答案（点区间）。
  const r = inferBounds(
    { predicate: 'memberOf', observedAt: 1050 },
    { valid_from: BIRTH }, null, 'concurrent',
  );
  assert.equal(r.validFrom, 1050);
  assert.equal(r.validTo, 1050);
  assert.equal(r.boundsSource, 'observed');
});

test('bounds: attribute 档不推导', () => {
  // 性别、民族这类不参与时间切片，推了也没意义。
  const r = inferBounds(
    { predicate: 'gender' }, { valid_from: BIRTH }, null, 'attribute',
  );
  assert.equal(r.validFrom, null);
  assert.equal(r.boundsSource, null);
});

test('bounds: persistent 不设年龄下限——出生即可成立', () => {
  // 早期版本对 persistent 也套了 15 岁下限，结果「1042 年生」的人
  // 与「1051 年卒」的朋友关系下界被推到 1057 年——关系在库里存在，
  // 却永远查不到。年龄约束只对需要行为能力的 concurrent 关系有意义。
  const r = inferBounds(
    { predicate: 'friend' },
    { valid_from: BIRTH, valid_to: DEATH }, null, 'persistent',
  );
  assert.equal(r.validFrom, BIRTH, '下界应为主体出生年');
  assert.equal(r.boundsSource, 'inferred');
});

test('bounds: concurrent 有年龄下限', () => {
  // 任职不可能在婴儿期成立。
  const r = inferBounds(
    { predicate: 'memberOf' },
    { valid_from: BIRTH, valid_to: DEATH }, null, 'concurrent',
  );
  assert.ok(r.validFrom > BIRTH, '下界应晚于出生');
  assert.equal(r.validFrom, BIRTH + yearsToDays(AGE_BOUNDS.memberOf.min));
});

test('bounds: 上界取参与者中较早的死亡年', () => {
  const r = inferBounds(
    { predicate: 'friend' },
    { valid_from: BIRTH, valid_to: DEATH },
    { valid_from: BIRTH + 100, valid_to: DEATH - 1000 },
    'persistent',
  );
  assert.equal(r.validTo, DEATH - 1000, '任一方死亡即终止');
});

test('bounds: 参与者无生卒时返回 null，不编造', () => {
  // 真正的缺损要能被统计到，不能假装推出来了。
  const r = inferBounds({ predicate: 'friend' }, null, null, 'persistent');
  assert.equal(r.validFrom, null);
  assert.equal(r.validTo, null);
  assert.equal(r.boundsSource, null);
});

test('bounds: 推导值用 JDN 单位，不是年份', () => {
  // 实体时间列是 JDN。早期版本按年份算，推出 2101658 这种数字，
  // 切片传 1050 永远对不上——这种错误不报错，只是静默返回空。
  const r = inferBounds(
    { predicate: 'memberOf' },
    { valid_from: BIRTH, valid_to: DEATH }, null, 'concurrent',
  );
  assert.ok(r.validFrom > 2000000, '应是 JDN 量级');
  assert.ok(r.validFrom < 2200000);
});

test('bounds: schema 有 bounds_source 列', () => {
  const fs = require('fs');
  const path = require('path');
  const schema = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'store', 'db_schema.js'), 'utf8');
  assert.match(schema, /bounds_source TEXT/);
});
