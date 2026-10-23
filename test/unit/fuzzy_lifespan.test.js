// 模糊生卒日期的解析链路。
//
// 背景：`era` 谓词已删除（它的 97.5% 取值是「隋唐及以后」，等于「不知道」）。
// 按 docs/architecture/节点类型与谓词.md §2.6，只知道大致时期的人应当得到
// **带区间的生卒日期**，而不是一条指向抽象朝代节点的边。
//
// 这条链路上有三个容易静默失败的环节，每个都对应一个真实踩过的坑：
//   1. `parseFuzzy` 原先只认「公元前」，不认「前」——导入器写出的正是「前300年」，
//      于是 `约 前300年 ± 30` 被读成公元 300 年，一个战国人变成了西晋人。
//   2. `lifespanFromProps` 原先直接调 `lifespanRange({birth, death})`，
//      不带 `birthFuzzy`，于是带 ± 的文本整体变成 null，时间线静默失配。
//   3. 「之前 / 之后」是开口区间。`parseYearMonth` 会取前缀数字，把
//      「1104年之前」读成精确的 1104 年——方向语义丢失。

const test = require('node:test');
const assert = require('node:assert/strict');

const J = require('../../src/time/julian.js');
const { lifespanFromProps } = require('../../src/store/graph_source.js');

test('模糊生卒: 「前N年」与「公元前N年」等价', () => {
  assert.deepEqual(J.parseFuzzy('约 前300年 ± 30'), { year: -299, radius: 30 });
  assert.deepEqual(J.parseFuzzy('约 公元前300年 ± 30'), { year: -299, radius: 30 });
});

test('模糊生卒: 带 ± 的日期进入 lifespan，而不是变成 null', () => {
  const r = lifespanFromProps({ 出生年月: '约 1104年 ± 30', 逝世时间: '约 1180年 ± 30' });
  assert.ok(r, '带 ± 的日期必须解析出区间');
  assert.ok(r.uncertainty > 0, '区间必须携带不确定性');
  // 双端区间要显示出起止年，而不是压成中点——否则生卒年就从时间线上消失了。
  // 1104±30 → 1074，1180±30 → 1210。
  const text = J.formatRange(r);
  assert.match(text, /1074/, `区间起点不对: ${text}`);
  assert.match(text, /1210/, `区间终点不对: ${text}`);
  assert.match(text, /–/, `双端区间应显示为范围: ${text}`);

  // 只有单端时才用 ± 表达估计点。
  const only = lifespanFromProps({ 逝世时间: '约 1108年 ± 30' });
  assert.match(J.formatRange(only), /±/);
});

test('模糊生卒: 公元前不会被静默读成公元后', () => {
  const r = lifespanFromProps({ 出生年月: '约 前300年 ± 30' });
  assert.ok(r);
  const text = J.formatRange(r);
  assert.match(text, /公元前/, `公元前被丢掉了: ${text}`);
});

test('模糊生卒: 「之前 / 之后」保留方向，不压成精确年', () => {
  // parseYearMonth 必须拒绝这两种写法，否则会取到前缀数字。
  assert.equal(J.parseYearMonth('1104年之前'), null);
  assert.equal(J.parseYearMonth('1104年之后'), null);

  const before = lifespanFromProps({ 出生年月: '1104年之前' });
  assert.match(J.formatRange(before), /之前/);

  const after = lifespanFromProps({ 逝世时间: '1104年之后' });
  assert.match(J.formatRange(after), /之后/);
});

test('模糊生卒: 精确年份仍是精确区间（不能因模糊支持而退化）', () => {
  const r = lifespanFromProps({ 出生年月: '1042年', 逝世时间: '1104年' });
  assert.equal(r.uncertainty, 0);
  assert.match(J.formatRange(r), /1042年 – 1104年/);
});
